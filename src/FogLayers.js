import {
	ClampToEdgeWrapping,
	Color,
	DataTexture,
	DataUtils,
	HalfFloatType,
	InstancedBufferGeometry,
	LinearFilter,
	Mesh,
	PlaneGeometry,
	RedFormat,
	RGBAFormat,
	ShaderMaterial,
	UniformsLib,
	UniformsUtils,
	Vector2,
	Vector3,
	WebGLRenderTarget,
} from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { simplex3D } from './glsl/simplex3D.js';
import { getHeight } from './terrain.js';

// 地面に沿ったメッシュを霧の上面の高さまで持ち上げ、その面を通る視線の長さで透明度を決める
//
// 1. 高さパス: 霧の柱の高さ H (上面の形のノイズ・谷/斜面・流体の濃度・めくれ上がり・歪み) を
//    毎フレーム 1 回テクスチャに書き出す
// 2. シート: 地形に沿ったメッシュを H * (i + 1) / N まで持ち上げる (N 枚。既定は 2 枚)
//    normal は H の勾配と地形の勾配から求める
// 3. 透明度: 厚さ H / N の霧の板を視線が通る距離から Beer-Lambert で求める
//    真上から見ると薄く、斜めから見ると濃くなる

const heightVertexShader = /* glsl */`
varying vec2 vUv;

void main() {

	vUv = uv;
	gl_Position = vec4( position.xy, 0.0, 1.0 );

}
`;

const heightFragmentShader = /* glsl */`
${ simplex3D }

uniform sampler2D uFog;
uniform sampler2D uVelocity;
uniform sampler2D uTerrain;
uniform vec2 uTerrainTexel;
uniform float uWorldSize;
uniform float uTime;
uniform vec2 uWind;
uniform vec2 uHeightRange;
uniform float uThickness;
uniform float uDistortion;
uniform float uLift;

varying vec2 vUv;

// 流体のフィールドはグリッド単位の細かい乱れや、衝撃でできる鋭い段差を含む
// そのまま頂点の高さに使うとピクピク揺れたり尖ったりするので、5x5 のガウシアン (1-4-6-4-1) でぼかす
// サンプル間隔は 2 テクセル (約 0.75m) で、全体で約 1.5m の幅でなだらかにする
vec4 blurred( sampler2D map, vec2 uv ) {

	vec2 t = uTerrainTexel * 2.0;
	vec4 sum = vec4( 0.0 );

	for ( int y = - 2; y <= 2; y ++ ) {

		for ( int x = - 2; x <= 2; x ++ ) {

			float wx = x == 0 ? 6.0 : ( abs( x ) == 1 ? 4.0 : 1.0 );
			float wy = y == 0 ? 6.0 : ( abs( y ) == 1 ? 4.0 : 1.0 );
			sum += texture2D( map, uv + vec2( float( x ), float( y ) ) * t ) * wx * wy;

		}

	}

	return sum / 256.0;

}

void main() {

	vec4 fog = blurred( uFog, vUv );
	float density = fog.z;

	// 押し寄せて溜まった分 (density > 1) は頭打ちにする (2.5 でも約 1.6)
	float excess = max( density - 1.0, 0.0 );
	float shapeDensity = min( density, 1.0 ) + excess / ( 1.0 + excess );
	float speed = length( blurred( uVelocity, vUv ).xy );

	// 流れで運ばれたノイズ座標
	vec2 coord = ( vUv - 0.5 ) * uWorldSize + fog.xy;
	vec2 drift = uWind * uTime;

	// 上面の形 (低周波)
	float shape = snoise( vec3( ( coord - drift ) * 0.06, uTime * 0.03 ) ) * 0.5 + 0.5;
	shape = smoothstep( 0.2, 0.85, shape );

	// 細かいもや (形には使わず、透明度だけに使う)
	vec3 p = vec3( ( coord - drift * 1.6 ) * 0.22, uTime * 0.1 );
	float wisp = ( snoise( p ) * 0.65 + snoise( p * 2.7 + 5.0 ) * 0.35 ) * 0.5 + 0.5;

	// 谷に溜まり、斜面では薄い
	float height = texture2D( uTerrain, vUv ).x;
	float cell = uWorldSize * uTerrainTexel.x;
	float gx = texture2D( uTerrain, vUv + vec2( uTerrainTexel.x, 0.0 ) ).x - texture2D( uTerrain, vUv - vec2( uTerrainTexel.x, 0.0 ) ).x;
	float gz = texture2D( uTerrain, vUv + vec2( 0.0, uTerrainTexel.y ) ).x - texture2D( uTerrain, vUv - vec2( 0.0, uTerrainTexel.y ) ).x;
	float normalY = 1.0 / sqrt( 1.0 + ( gx * gx + gz * gz ) / ( 4.0 * cell * cell ) );
	float valley = mix( 1.0, 0.25, smoothstep( uHeightRange.x, uHeightRange.y, height ) );
	float slope = mix( 0.4, 1.0, smoothstep( 0.8, 0.98, normalY ) );

	// 吹き飛ばされた先端では霧がめくれ上がる
	// 普段の微風の速度の揺らぎで高さがピクつかないよう、1.5m/s 未満は無視する
	// 尖らないよう、最大 1.6 倍に向かって滑らかに飽和させる
	float lift = 1.0 + 0.6 * ( 1.0 - exp( - max( speed - 1.5, 0.0 ) * uLift ) );

	float top = uThickness * mix( 0.12, 1.0, shape ) * valley * slope * shapeDensity * lift;

	// 高さ全体も柔らかく頭打ちにする
	// uThickness まではそのまま、それを超えた分は緩やかに飽和させて最大 1.5 倍に収める
	float knee = uThickness;
	float room = uThickness * 0.5;
	top = top < knee ? top : knee + room * ( 1.0 - exp( - ( top - knee ) / room ) );

	// シンプレックスノイズで面を歪める (霧がある所だけ)
	float distortion = snoise( vec3( ( coord - drift * 1.3 ) * 0.25, uTime * 0.08 ) ) * uDistortion;
	top = max( top + distortion * smoothstep( 0.0, 0.3, top ), 0.0 );

	// 霧フィールドの端は 0 にする
	vec2 edge = smoothstep( 0.0, 0.08, vUv ) * smoothstep( 1.0, 0.92, vUv );
	top *= edge.x * edge.y;

	gl_FragColor = vec4( top, wisp, density, 1.0 );

}
`;

const vertexShader = /* glsl */`
uniform sampler2D uFogHeight;
uniform vec2 uFogHeightTexel;
uniform float uWorldSize;
uniform float uSheetCount;
uniform float uGrazingStart;

varying vec2 vUv;
varying vec3 vWorldPosition;
varying vec3 vNormal;
varying float vSheet;
varying float vSlab;
varying float vWisp;
varying float vDensity;

#include <fog_pars_vertex>

void main() {

	vec2 uv = position.xz / uWorldSize + 0.5;
	vec4 fog = texture2D( uFogHeight, uv );
	float sheet = float( gl_InstanceID + 1 ) / uSheetCount;

	// 浅い角度から見るとシートが別々の層として見えるので、視線が寝るほど上面に寄せて 1 枚に重ねる
	// (透明度は霧全体の厚みで決まるので、重なっても濃さは変わらない)
	vec3 terrainPosition = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
	float viewCosine = abs( dot( normalize( cameraPosition - terrainPosition ), normal ) );
	float grazing = 1.0 - smoothstep( uGrazingStart * 0.4, uGrazingStart, viewCosine );
	sheet = mix( sheet, 1.0, grazing );

	vec3 transformed = position;
	transformed.y += fog.x * sheet;

	// normal: 地形の勾配 + 霧の高さの勾配 (2 テクセル幅の差分で滑らかにする)
	vec2 offset = uFogHeightTexel * 2.0;
	float cell = uWorldSize * offset.x;
	float hx = texture2D( uFogHeight, uv + vec2( offset.x, 0.0 ) ).x - texture2D( uFogHeight, uv - vec2( offset.x, 0.0 ) ).x;
	float hz = texture2D( uFogHeight, uv + vec2( 0.0, offset.y ) ).x - texture2D( uFogHeight, uv - vec2( 0.0, offset.y ) ).x;
	vec2 terrainGradient = - normal.xz / normal.y;
	vec2 gradient = terrainGradient + vec2( hx, hz ) / ( 2.0 * cell ) * sheet;

	vUv = uv;
	vWorldPosition = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
	vNormal = normalize( vec3( - gradient.x, 1.0, - gradient.y ) );
	vSheet = sheet;
	vSlab = fog.x / uSheetCount;
	vWisp = fog.y;
	vDensity = fog.z;

	vec4 mvPosition = modelViewMatrix * vec4( transformed, 1.0 );
	gl_Position = projectionMatrix * mvPosition;

	#include <fog_vertex>

}
`;

const fragmentShader = /* glsl */`
uniform sampler2D uFog;
uniform float uOpacity;
uniform vec3 uColorLow;
uniform vec3 uColorHigh;
uniform vec3 uLightDirection;

varying vec2 vUv;
varying vec3 vWorldPosition;
varying vec3 vNormal;
varying float vSheet;
varying float vSlab;
varying float vWisp;
varying float vDensity;

#include <fog_pars_fragment>

void main() {

	if ( vSlab < 0.002 ) discard;

	vec3 normal = normalize( vNormal );
	vec3 viewDirection = normalize( cameraPosition - vWorldPosition );

	// 厚さ vSlab の板を視線が通る長さ。浅い角度で急に濃くなりシートの輪郭が帯状に目立つので、
	// 下限を高めにして濃さの上がり方を抑える
	float cosine = max( abs( dot( viewDirection, normal ) ), 0.3 );
	float path = vSlab / cosine;
	float extinction = uOpacity * mix( 0.25, 1.0, smoothstep( 0.15, 0.85, vWisp ) );
	float alpha = 1.0 - exp( - extinction * path );

	// メッシュの形はぼかした濃度で柔らかくしているので、穴の輪郭は元の濃度で透明度に出す
	alpha *= smoothstep( 0.0, 0.6, texture2D( uFog, vUv ).z );

	// 太陽側を向いた面・上のシート・押し寄せて溜まった所ほど明るい
	float light = dot( normal, uLightDirection ) * 0.5 + 0.5;
	float brightness = light * 0.45 + vSheet * 0.2 + max( vDensity - 1.0, 0.0 ) * 0.3;
	vec3 color = mix( uColorLow, uColorHigh, clamp( brightness, 0.0, 1.0 ) );

	gl_FragColor = vec4( color, alpha );

	#include <fog_fragment>

}
`;

// メッシュ表示用。霧と同じ頂点シェーダーで、シートごとに色を変えたワイヤーフレームを描く
const wireframeFragmentShader = /* glsl */`
uniform vec3 uWireColorLow;
uniform vec3 uWireColorHigh;
uniform float uWireOpacity;
uniform float uSheetCount;

varying float vSheet;

#include <fog_pars_fragment>

void main() {

	// 一番下のシートが uWireColorLow、一番上が uWireColorHigh
	float t = ( vSheet * uSheetCount - 1.0 ) / max( uSheetCount - 1.0, 1.0 );
	gl_FragColor = vec4( mix( uWireColorLow, uWireColorHigh, t ), uWireOpacity );

	#include <fog_fragment>

}
`;

function createTerrainTexture( size, resolution ) {

	const data = new Uint16Array( resolution * resolution );
	let minHeight = Infinity;
	let maxHeight = - Infinity;

	for ( let y = 0; y < resolution; y ++ ) {

		for ( let x = 0; x < resolution; x ++ ) {

			const height = getHeight( ( ( x + 0.5 ) / resolution - 0.5 ) * size, ( ( y + 0.5 ) / resolution - 0.5 ) * size );
			data[ y * resolution + x ] = DataUtils.toHalfFloat( height );
			minHeight = Math.min( minHeight, height );
			maxHeight = Math.max( maxHeight, height );

		}

	}

	const texture = new DataTexture( data, resolution, resolution, RedFormat, HalfFloatType );
	texture.minFilter = LinearFilter;
	texture.magFilter = LinearFilter;
	texture.needsUpdate = true;

	return { texture, minHeight, maxHeight };

}

export class FogLayers extends Mesh {

	constructor( simulation, { sheets = 2, segments = 192, heightResolution = 256 } = {} ) {

		const size = simulation.worldSize;

		const plane = new PlaneGeometry( size, size, segments, segments );
		plane.rotateX( - Math.PI / 2 );

		const position = plane.attributes.position;

		for ( let i = 0; i < position.count; i ++ ) {

			position.setY( i, getHeight( position.getX( i ), position.getZ( i ) ) + 0.02 );

		}

		plane.computeVertexNormals();

		// シートは gl_InstanceID で区別する
		const geometry = new InstancedBufferGeometry();
		geometry.index = plane.index;
		geometry.setAttribute( 'position', plane.attributes.position );
		geometry.setAttribute( 'normal', plane.attributes.normal );
		geometry.instanceCount = sheets;

		const heightTexel = new Vector2( 1 / heightResolution, 1 / heightResolution );

		const material = new ShaderMaterial( {
			vertexShader,
			fragmentShader,
			uniforms: UniformsUtils.merge( [
				UniformsLib.fog,
				{
					uFogHeight: { value: null },
					uFog: { value: null },
					uFogHeightTexel: { value: heightTexel },
					uWorldSize: { value: size },
					uSheetCount: { value: sheets },
					uGrazingStart: { value: 0.6 },
					uOpacity: { value: 0.7 },
					uColorLow: { value: new Color( 0x968daf ) },
					uColorHigh: { value: new Color( 0xf0ecf7 ) },
					uLightDirection: { value: new Vector3( - 0.6, 0.6, - 0.4 ).normalize() },
				},
			] ),
			transparent: true,
			depthWrite: false,
			fog: true,
		} );

		super( geometry, material );

		this.simulation = simulation;
		this.frustumCulled = false;
		this.renderOrder = 1;

		// 高さパス
		const terrain = createTerrainTexture( size, heightResolution );
		this._terrainTexture = terrain.texture;

		this._heightTarget = new WebGLRenderTarget( heightResolution, heightResolution, {
			type: HalfFloatType,
			format: RGBAFormat,
			minFilter: LinearFilter,
			magFilter: LinearFilter,
			wrapS: ClampToEdgeWrapping,
			wrapT: ClampToEdgeWrapping,
			depthBuffer: false,
		} );
		this.heightMaterial = new ShaderMaterial( {
			vertexShader: heightVertexShader,
			fragmentShader: heightFragmentShader,
			uniforms: {
				uFog: { value: null },
				uVelocity: { value: null },
				uTerrain: { value: terrain.texture },
				uTerrainTexel: { value: heightTexel },
				uWorldSize: { value: size },
				uTime: { value: 0 },
				uWind: { value: new Vector2( 0.35, 0.12 ) },
				uHeightRange: { value: new Vector2( terrain.minHeight, terrain.maxHeight ) },
				uThickness: { value: 1.4 },
				uDistortion: { value: 0.12 },
				uLift: { value: 0.25 },
			},
			depthTest: false,
			depthWrite: false,
		} );
		this._heightQuad = new FullScreenQuad( this.heightMaterial );
		material.uniforms.uFogHeight.value = this._heightTarget.texture;

		// メッシュ表示。uniforms は霧本体と共有し、頂点の動きを一致させる
		this.wireframe = new Mesh( geometry, new ShaderMaterial( {
			vertexShader,
			fragmentShader: wireframeFragmentShader,
			uniforms: {
				...material.uniforms,
				uWireColorLow: { value: new Color( 0x00c8ff ) },
				uWireColorHigh: { value: new Color( 0xff3dc8 ) },
				uWireOpacity: { value: 0.3 },
			},
			wireframe: true,
			transparent: true,
			depthWrite: false,
			fog: true,
		} ) );
		this.wireframe.frustumCulled = false;
		this.wireframe.renderOrder = 2;
		this.wireframe.visible = false;
		this.add( this.wireframe );

	}

	get sheets() {

		return this.geometry.instanceCount;

	}

	set sheets( value ) {

		this.geometry.instanceCount = value;
		this.material.uniforms.uSheetCount.value = value;

	}

	get showFog() {

		return this.material.visible;

	}

	set showFog( value ) {

		this.material.visible = value;

	}

	get showMesh() {

		return this.wireframe.visible;

	}

	set showMesh( value ) {

		this.wireframe.visible = value;

	}

	update( renderer, time ) {

		this.material.uniforms.uFog.value = this.simulation.fogTexture;

		const uniforms = this.heightMaterial.uniforms;
		uniforms.uTime.value = time;
		uniforms.uFog.value = this.simulation.fogTexture;
		uniforms.uVelocity.value = this.simulation.velocityTexture;

		const previousTarget = renderer.getRenderTarget();
		renderer.setRenderTarget( this._heightTarget );
		this._heightQuad.render( renderer );
		renderer.setRenderTarget( previousTarget );

	}

	dispose() {

		this.geometry.dispose();
		this.material.dispose();
		this.wireframe.material.dispose();
		this.heightMaterial.dispose();
		this._heightTarget.dispose();
		this._heightQuad.dispose();
		this._terrainTexture.dispose();

	}

}
