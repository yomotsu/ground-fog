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
// 2. 層: 地形に沿ったメッシュを H * (i + 1) / N まで持ち上げる (N 層。既定は 4 層)
//    normal は H の勾配と地形の勾配から求める
// 3. 透明度: 霧の板を視線が通る距離から Beer-Lambert で求める
//    真上から見ると薄く、斜めから見ると濃くなる
//    板の厚さには、溜まり・めくれ上がりを除いた普段の厚み (高さパスの w) に、
//    ピクセルごとの濃度から決めた残り具合 (穴でも uResidual だけ残る) を掛けて使う

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
uniform sampler2D uCurl;
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
// そのまま頂点の高さに使うとピクピク揺れたり尖ったりするので、ガウシアンでぼかす
// 縦横に分かれたカーネルだと小さな穴が四角くなるので、同心円状 (中心 + 6 + 12 点) にサンプルする
// 半径の単位は scale テクセル (2 で約 0.75m、全体で約 1.5m の幅) でなだらかにする
vec4 blurred( sampler2D map, vec2 uv, float scale ) {

	vec2 t = uTerrainTexel * scale;
	vec4 sum = texture2D( map, uv );
	float total = 1.0;

	for ( int k = 0; k < 6; k ++ ) {

		float angle = float( k ) * 1.0472;
		sum += texture2D( map, uv + vec2( cos( angle ), sin( angle ) ) * t ) * 0.6;

	}

	for ( int k = 0; k < 12; k ++ ) {

		float angle = float( k ) * 0.5236 + 0.2618;
		sum += texture2D( map, uv + vec2( cos( angle ), sin( angle ) ) * t * 2.0 ) * 0.14;

	}

	total += 6.0 * 0.6 + 12.0 * 0.14;
	return sum / total;

}

void main() {

	vec4 fog = blurred( uFog, vUv, 2.0 );
	float density = fog.z;

	// 押し寄せて溜まった分 (density > 1) は頭打ちにする (2.5 でも約 1.6)
	float excess = max( density - 1.0, 0.0 );
	float shapeDensity = min( density, 1.0 ) + excess / ( 1.0 + excess );
	float speed = length( blurred( uVelocity, vUv, 2.0 ).xy );

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

	float base = uThickness * mix( 0.12, 1.0, shape ) * valley * slope;
	float top = base * shapeDensity * lift;

	// 透明度に使う厚み。溜まり (density > 1) やめくれ上がりは形だけに効かせ、
	// 衝撃の周りで白く濃くならないよう、普段の厚みで計算する
	// 穴の分はフラグメントでピクセルごとの濃度から減らす (輪郭をくっきりさせ、うっすら残すため)
	float opacityTop = base;

	// 高さ全体も柔らかく頭打ちにする
	// uThickness まではそのまま、それを超えた分は緩やかに飽和させて最大 1.5 倍に収める
	float knee = uThickness;
	float room = uThickness * 0.5;
	top = top < knee ? top : knee + room * ( 1.0 - exp( - ( top - knee ) / room ) );

	// シンプレックスノイズで面を歪める (霧がある所だけ)
	float distortion = snoise( vec3( ( coord - drift * 1.3 ) * 0.25, uTime * 0.08 ) ) * uDistortion;
	top = max( top + distortion * smoothstep( 0.0, 0.3, top ), 0.0 );
	opacityTop = max( opacityTop + distortion * smoothstep( 0.0, 0.3, opacityTop ), 0.0 );

	// 霧フィールドの端は 0 にする
	vec2 edge = smoothstep( 0.0, 0.08, vUv ) * smoothstep( 1.0, 0.92, vUv );
	top *= edge.x * edge.y;
	opacityTop *= edge.x * edge.y;

	// 渦の芯らしさ。渦度は普段の流れでもグリッド単位の細かい乱れで大きくなるが、向きがバラバラなので
	// 符号付きのままぼかすと打ち消し合う。向きの揃った本物の渦だけが残る
	// (使う側でかき乱された所だけに掛けるので、普段の流れで多少反応しても問題ない)
	// 広めにぼかして、巻きが大きく柔らかい範囲で効くようにする
	float swirl = smoothstep( 0.6, 2.5, abs( blurred( uCurl, vUv, 3.5 ).x ) );

	gl_FragColor = vec4( top, wisp, swirl, opacityTop );

}
`;

const vertexShader = /* glsl */`
${ simplex3D }

uniform sampler2D uFogHeight;
uniform vec2 uFogHeightTexel;
uniform float uWorldSize;
uniform float uLayerCount;
uniform float uLayerJitter;
uniform float uLayerSpacing;
uniform float uTime;

varying vec2 vUv;
varying vec3 vWorldPosition;
varying vec3 vNormal;
varying float vLayer;
varying float vLayerIndex;
varying float vSlab;
varying float vWisp;
varying float vSwirl;

#include <fog_pars_vertex>

void main() {

	vec2 uv = position.xz / uWorldSize + 0.5;
	vec4 fog = texture2D( uFogHeight, uv );
	float layer = float( gl_InstanceID + 1 ) / uLayerCount;

	// 層の縁が平行に揃うと段差の線として見えるので、層ごとに違うノイズで高さを少しずらす
	// (一番上の層は霧の上面の形を保つため、ずらさない)
	float index = float( gl_InstanceID );
	float jitter = snoise( vec3( position.xz * 0.3, index * 3.7 + uTime * 0.05 ) );
	layer = clamp( layer + jitter * uLayerJitter / uLayerCount * step( index + 1.5, uLayerCount ), 0.0, 1.0 );

	// uLayerSpacing で層の間隔だけを詰める (濃さは霧の厚みから求めるので変わらない)
	vec3 transformed = position;
	transformed.y += fog.x * layer * uLayerSpacing;

	// normal: 地形の勾配 + 霧の高さの勾配 (2 テクセル幅の差分で滑らかにする)
	vec2 offset = uFogHeightTexel * 2.0;
	float cell = uWorldSize * offset.x;
	float hx = texture2D( uFogHeight, uv + vec2( offset.x, 0.0 ) ).x - texture2D( uFogHeight, uv - vec2( offset.x, 0.0 ) ).x;
	float hz = texture2D( uFogHeight, uv + vec2( 0.0, offset.y ) ).x - texture2D( uFogHeight, uv - vec2( 0.0, offset.y ) ).x;
	vec2 terrainGradient = - normal.xz / normal.y;
	vec2 gradient = terrainGradient + vec2( hx, hz ) / ( 2.0 * cell ) * layer * uLayerSpacing;

	vUv = uv;
	vWorldPosition = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
	vNormal = normalize( vec3( - gradient.x, 1.0, - gradient.y ) );
	vLayer = layer;
	vLayerIndex = float( gl_InstanceID );
	vSlab = fog.w / uLayerCount;
	vWisp = fog.y;
	vSwirl = fog.z;

	vec4 mvPosition = modelViewMatrix * vec4( transformed, 1.0 );
	gl_Position = projectionMatrix * mvPosition;

	#include <fog_vertex>

}
`;

const fragmentShader = /* glsl */`
${ simplex3D }

uniform sampler2D uFog;
uniform float uTime;
uniform vec2 uWind;
uniform float uSwirlDetail;
uniform float uResidual;
uniform vec2 uFogTexel;
uniform float uLayerFalloff;
uniform float uLayerCount;
uniform float uLayerWeightSum;
uniform float uOpacity;
uniform vec3 uColorLow;
uniform vec3 uColorHigh;
uniform vec3 uLightDirection;

varying vec2 vUv;
varying vec3 vWorldPosition;
varying vec3 vNormal;
varying float vLayer;
varying float vLayerIndex;
varying float vSlab;
varying float vWisp;
varying float vSwirl;

#include <fog_pars_fragment>

void main() {

	if ( vSlab < 0.002 ) discard;

	vec3 normal = normalize( vNormal );
	vec3 viewDirection = normalize( cameraPosition - vWorldPosition );

	// メッシュの形はぼかした流体の値で柔らかくしているので、細かい流れはピクセルごとに元の値から出す
	vec4 fog = texture2D( uFog, vUv );
	float density = fog.z;

	// 穴: 濃度に応じて霧の板を薄くする。衝撃で吹き飛ばされた所でも uResidual だけうっすら残す
	// 縁がトゲトゲに硬くならないよう、周囲 5 点 (半径約 0.5m) で平均した濃度を広めの幅で使う
	// (テクセルの間で線形補間されるので、斜め 4 点でも十分なめらかになる)
	vec2 offset = uFogTexel * 2.0;
	float softDensity = density * 0.2;
	softDensity += texture2D( uFog, vUv + offset ).z * 0.2;
	softDensity += texture2D( uFog, vUv - offset ).z * 0.2;
	softDensity += texture2D( uFog, vUv + vec2( offset.x, - offset.y ) ).z * 0.2;
	softDensity += texture2D( uFog, vUv + vec2( - offset.x, offset.y ) ).z * 0.2;

	float remain = mix( uResidual, 1.0, smoothstep( 0.0, 1.0, softDensity ) );

	// 厚さ vSlab の板を視線が通る長さ。浅い角度で急に濃くなり層の輪郭が帯状に目立つので、
	// 下限を高めにして濃さの上がり方を抑える
	float cosine = max( abs( dot( viewDirection, normal ) ), 0.3 );
	// 層ごとの濃さの配分。下の層ほど濃く、上ほど薄くして、霧の上の縁をグラデーションで消す
	// (1 枚の面だと縁がスパッと切れ、浅い角度で丘の峰ごとの霧の帯が層のように見える)
	// 合計は変わらないよう正規化する (uLayerWeightSum は CPU 側で計算)
	float layerIndex = floor( vLayerIndex + 0.5 );
	float weight = pow( 1.0 - layerIndex / uLayerCount, uLayerFalloff ) / uLayerWeightSum * uLayerCount;
	float path = vSlab * remain * weight / cosine;
	float extinction = uOpacity * mix( 0.25, 1.0, smoothstep( 0.15, 0.85, vWisp ) );
	float alpha = 1.0 - exp( - extinction * path );

	// 流れで運ばれたノイズ座標でノイズを読む。渦に巻き込まれた模様がくるくると見える
	// 静かな所に掛けると斑になるので、かき乱された所 (fog.w) だけに掛ける
	// 細かいノイズは引き伸ばされると何本もの細い筋になるので、渦が通り過ぎた後の尾では
	// 低い周波数の滑らかなノイズに切り替え、渦の芯 (vSwirl) だけ細かいノイズでくっきり巻かせる
	float detail = 0.0;
	float stir = fog.w * uSwirlDetail;

	if ( stir > 0.01 ) {

		vec2 coord = vWorldPosition.xz + fog.xy - uWind * uTime * 1.8;
		float phase = uTime * 0.12 + vLayer * 0.7;

		vec3 q = vec3( coord * 0.32, phase );
		float smoothDetail = snoise( q ) * 0.9 + snoise( q * 2.0 + 3.0 ) * 0.1;
		float smoothMask = smoothstep( - 1.0, 1.0, smoothDetail );

		float curl = smoothstep( 0.05, 0.5, vSwirl );
		float mask = smoothMask;

		if ( curl > 0.01 ) {

			vec3 r = vec3( coord * 0.4, phase );
			float fineDetail = snoise( r ) * 0.8 + snoise( r * 2.0 + 3.0 ) * 0.2;
			mask = mix( smoothMask, smoothstep( - 0.55, 0.55, fineDetail ), curl );
			smoothDetail = mix( smoothDetail, fineDetail, curl );

		}

		// 尾は控えめ、芯はしっかり
		float amount = stir * mix( 0.3, 1.0, curl );
		alpha *= mix( 1.0, mask, amount );
		detail = smoothDetail * amount;

	}

	// 太陽側を向いた面・上の層ほど明るい。押し寄せて溜まった所はわずかに明るくする
	float light = dot( normal, uLightDirection ) * 0.5 + 0.5;
	float brightness = light * 0.45 + vLayer * 0.2 + min( max( density - 1.0, 0.0 ), 1.0 ) * 0.08 + detail * 0.04;
	vec3 color = mix( uColorLow, uColorHigh, clamp( brightness, 0.0, 1.0 ) );

	gl_FragColor = vec4( color, alpha );

	#include <fog_fragment>

}
`;

// メッシュ表示用。霧と同じ頂点シェーダーで、層ごとに色を変えたワイヤーフレームを描く
const wireframeFragmentShader = /* glsl */`
uniform vec3 uWireColorLow;
uniform vec3 uWireColorHigh;
uniform float uWireOpacity;
uniform float uLayerCount;

varying float vLayer;

#include <fog_pars_fragment>

void main() {

	// 一番下の層が uWireColorLow、一番上が uWireColorHigh
	float t = ( vLayer * uLayerCount - 1.0 ) / max( uLayerCount - 1.0, 1.0 );
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

	constructor( simulation, { layerCount = 4, segments = 192, heightResolution = 256 } = {} ) {

		const size = simulation.worldSize;

		const plane = new PlaneGeometry( size, size, segments, segments );
		plane.rotateX( - Math.PI / 2 );

		const position = plane.attributes.position;

		for ( let i = 0; i < position.count; i ++ ) {

			position.setY( i, getHeight( position.getX( i ), position.getZ( i ) ) + 0.02 );

		}

		plane.computeVertexNormals();

		// 層は gl_InstanceID で区別する
		const geometry = new InstancedBufferGeometry();
		geometry.index = plane.index;
		geometry.setAttribute( 'position', plane.attributes.position );
		geometry.setAttribute( 'normal', plane.attributes.normal );
		geometry.instanceCount = layerCount;

		const heightTexel = new Vector2( 1 / heightResolution, 1 / heightResolution );

		const material = new ShaderMaterial( {
			vertexShader,
			fragmentShader,
			uniforms: UniformsUtils.merge( [
				UniformsLib.fog,
				{
					uFogHeight: { value: null },
					uFog: { value: null },
					uTime: { value: 0 },
					uWind: { value: null },
					uSwirlDetail: { value: 0.6 },
					uResidual: { value: 0.15 },
					uLayerFalloff: { value: 1.5 },
					uLayerWeightSum: { value: 1 },
					uLayerJitter: { value: 0.6 },
					uLayerSpacing: { value: 0.25 },
					uFogTexel: { value: new Vector2( 1 / simulation.resolution, 1 / simulation.resolution ) },
					uFogHeightTexel: { value: heightTexel },
					uWorldSize: { value: size },
					uLayerCount: { value: layerCount },
					uOpacity: { value: 1.4 },
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
				uCurl: { value: null },
				uTerrain: { value: terrain.texture },
				uTerrainTexel: { value: heightTexel },
				uWorldSize: { value: size },
				uTime: { value: 0 },
				uWind: { value: new Vector2( 0.35, 0.12 ) },
				uHeightRange: { value: new Vector2( terrain.minHeight, terrain.maxHeight ) },
				uThickness: { value: 1.4 },
				uDistortion: { value: 0.2 },
				uLift: { value: 0.25 },
			},
			depthTest: false,
			depthWrite: false,
		} );
		this._heightQuad = new FullScreenQuad( this.heightMaterial );
		material.uniforms.uFogHeight.value = this._heightTarget.texture;
		// 時間と風は高さパスと共有する
		material.uniforms.uTime = this.heightMaterial.uniforms.uTime;
		material.uniforms.uWind = this.heightMaterial.uniforms.uWind;

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

	get layerCount() {

		return this.geometry.instanceCount;

	}

	set layerCount( value ) {

		this.geometry.instanceCount = value;
		this.material.uniforms.uLayerCount.value = value;

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

		// 層ごとの濃さの配分の合計 (フラグメントでの正規化用)
		const layerUniforms = this.material.uniforms;
		const count = layerUniforms.uLayerCount.value;
		let weightSum = 0;

		for ( let i = 0; i < count; i ++ ) {

			weightSum += Math.pow( 1 - i / count, layerUniforms.uLayerFalloff.value );

		}

		layerUniforms.uLayerWeightSum.value = weightSum;
		layerUniforms.uFog.value = this.simulation.fogTexture;

		const uniforms = this.heightMaterial.uniforms;
		uniforms.uTime.value = time;
		uniforms.uFog.value = this.simulation.fogTexture;
		uniforms.uVelocity.value = this.simulation.velocityTexture;
		uniforms.uCurl.value = this.simulation.curlTexture;

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
