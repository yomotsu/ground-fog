import {
	Box2,
	Box3,
	ClampToEdgeWrapping,
	Color,
	DataTexture,
	DataUtils,
	DepthTexture,
	HalfFloatType,
	LinearFilter,
	NearestFilter,
	RedFormat,
	RGBAFormat,
	ShaderMaterial,
	Vector2,
	Vector3,
	Vector4,
	WebGLRenderTarget,
} from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { simplex3D } from './glsl/simplex3D.js';
import { getHeight } from './terrain.js';

// 2D の流体シミュレーションの霧を、高さ方向に膨らませた 3D の密度として描くボリュメトリックフォグ
// (Zelda の "light 2D sim + density inflated on Y" / Returnal のボリュメトリックフォグの考え方)
//
// 1. 柱パス: 地面上の各点について、霧の柱の高さ H と、真上から見たときの光学的な厚み W を
//    毎フレーム 1 回テクスチャに書き出す (2D の流体の濃度・穴・渦の模様はここで反映する)
// 2. シーンを深度付きでレンダーターゲットに描く
// 3. 霧パス (低解像度): 各ピクセルで、カメラから「シーンの深度」と「霧の高さの範囲」が重なる区間を進み、
//    密度 = W / H * ( n + 1 ) * ( 1 - h / H )^n (地面ほど濃く上ほど薄い。高さ方向に積分すると W) を積算する
//    面を描かないので層は見えず、物体との交差はシーンの深度で止まるので柔らかくなる
// 4. 合成: 深度を見ながら霧を拡大し、シーンに重ねてトーンマッピングする

const quadVertexShader = /* glsl */`
varying vec2 vUv;

void main() {

	vUv = uv;
	gl_Position = vec4( position.xy, 0.0, 1.0 );

}
`;

const columnFragmentShader = /* glsl */`
${ simplex3D }

uniform sampler2D uFog;
uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform sampler2D uTerrain;
uniform vec2 uTerrainTexel;
uniform vec2 uBlurTexel;
uniform vec2 uFogTexel;
uniform float uWorldSize;
uniform float uTime;
uniform vec2 uWind;
uniform vec2 uHeightRange;
uniform float uThickness;
uniform float uDistortion;
uniform float uLift;
uniform float uResidual;
uniform float uSwirlDetail;

varying vec2 vUv;

// 流体のフィールドはグリッド単位の細かい乱れや、衝撃でできる鋭い段差を含む
// 形に使うと尖るので、同心円状 (中心 + 6 + 12 点) のガウシアンでぼかす
// 半径の単位は scale * uBlurTexel (scale 2 で約 0.75m)
vec4 blurred( sampler2D map, vec2 uv, float scale ) {

	vec2 t = uBlurTexel * scale;
	vec4 sum = texture2D( map, uv );

	for ( int k = 0; k < 6; k ++ ) {

		float angle = float( k ) * 1.0472;
		sum += texture2D( map, uv + vec2( cos( angle ), sin( angle ) ) * t ) * 0.6;

	}

	for ( int k = 0; k < 12; k ++ ) {

		float angle = float( k ) * 0.5236 + 0.2618;
		sum += texture2D( map, uv + vec2( cos( angle ), sin( angle ) ) * t * 2.0 ) * 0.14;

	}

	return sum / ( 1.0 + 6.0 * 0.6 + 12.0 * 0.14 );

}

void main() {

	vec4 fogSoft = blurred( uFog, vUv, 2.0 );
	float density = fogSoft.z;

	// 押し寄せて溜まった分 (density > 1) は頭打ちにする (2.5 でも約 1.6)
	float excess = max( density - 1.0, 0.0 );
	float shapeDensity = min( density, 1.0 ) + excess / ( 1.0 + excess );
	float speed = length( blurred( uVelocity, vUv, 2.0 ).xy );

	// 流れで運ばれたノイズ座標
	vec2 world = ( vUv - 0.5 ) * uWorldSize;
	vec2 coord = world + fogSoft.xy;
	vec2 drift = uWind * uTime;

	// 上面の形 (低周波)
	float shape = snoise( vec3( ( coord - drift ) * 0.06, uTime * 0.03 ) ) * 0.5 + 0.5;
	shape = smoothstep( 0.2, 0.85, shape );

	// 細かいもや (濃さのムラ)
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

	// 吹き飛ばされた先端では霧がめくれ上がる (普段の微風では反応しない)
	float lift = 1.0 + 0.6 * ( 1.0 - exp( - max( speed - 1.5, 0.0 ) * uLift ) );

	float base = uThickness * mix( 0.12, 1.0, shape ) * valley * slope;

	// 柱の高さ H。溜まり・めくれ上がりで高くなるが、柔らかく頭打ちにする (最大 1.5 倍)
	float top = base * shapeDensity * lift;
	float knee = uThickness;
	float room = uThickness * 0.5;
	top = top < knee ? top : knee + room * ( 1.0 - exp( - ( top - knee ) / room ) );

	// シンプレックスノイズで上面を歪める (霧がある所だけ)
	float distortion = snoise( vec3( ( coord - drift * 1.3 ) * 0.25, uTime * 0.08 ) ) * uDistortion;
	top = max( top + distortion * smoothstep( 0.0, 0.3, top ), 0.0 );

	// 光学的な厚み W (真上から見た霧の量)
	// 溜まり・めくれ上がりは形 (H) だけに効かせ、衝撃の周りで白く濃くならないよう普段の厚みで求める
	float thickness = max( base + distortion * smoothstep( 0.0, 0.3, base ), 0.0 );

	// 穴: 濃度に応じて薄くし、吹き飛ばされた所でも uResidual だけうっすら残す
	vec4 fog = texture2D( uFog, vUv );
	vec2 offset = uFogTexel * 2.0;
	float softDensity = fog.z * 0.2;
	softDensity += texture2D( uFog, vUv + offset ).z * 0.2;
	softDensity += texture2D( uFog, vUv - offset ).z * 0.2;
	softDensity += texture2D( uFog, vUv + vec2( offset.x, - offset.y ) ).z * 0.2;
	softDensity += texture2D( uFog, vUv + vec2( - offset.x, offset.y ) ).z * 0.2;
	thickness *= mix( uResidual, 1.0, smoothstep( 0.0, 1.0, softDensity ) );

	// もやのムラ
	thickness *= mix( 0.25, 1.0, smoothstep( 0.15, 0.85, wisp ) );

	// 渦の模様。かき乱された所 (fog.w) だけに掛ける
	// 渦が通り過ぎた後の尾では低い周波数の滑らかなノイズ、渦の芯ではくっきりしたノイズで巻かせる
	// 渦の芯らしさは、渦度を符号付きのままぼかして求める (向きの揃った本物の渦だけが残る)
	float detail = 0.0;
	float stir = fog.w * uSwirlDetail;

	if ( stir > 0.01 ) {

		vec2 swirlCoord = world + fog.xy - uWind * uTime * 1.8;
		float phase = uTime * 0.12;

		vec3 q = vec3( swirlCoord * 0.32, phase );
		float smoothDetail = snoise( q ) * 0.9 + snoise( q * 2.0 + 3.0 ) * 0.1;
		float mask = smoothstep( - 1.0, 1.0, smoothDetail );

		float curl = smoothstep( 0.05, 0.5, smoothstep( 0.6, 2.5, abs( blurred( uCurl, vUv, 3.5 ).x ) ) );

		if ( curl > 0.01 ) {

			vec3 r = vec3( swirlCoord * 0.4, phase );
			float fineDetail = snoise( r ) * 0.8 + snoise( r * 2.0 + 3.0 ) * 0.2;
			mask = mix( mask, smoothstep( - 0.55, 0.55, fineDetail ), curl );
			smoothDetail = mix( smoothDetail, fineDetail, curl );

		}

		float amount = stir * mix( 0.3, 1.0, curl );
		thickness *= mix( 1.0, mask, amount );
		detail = smoothDetail * amount;

	}

	// 霧フィールドの端は 0 にする
	vec2 edge = smoothstep( 0.0, 0.08, vUv ) * smoothstep( 1.0, 0.92, vUv );
	top *= edge.x * edge.y;
	thickness *= edge.x * edge.y;

	// 押し寄せて溜まった所はわずかに明るくする
	float brightness = min( excess, 1.0 ) * 0.08 + detail * 0.04;

	gl_FragColor = vec4( top, thickness, brightness, 0.0 );

}
`;

const marchFragmentShader = /* glsl */`
#include <packing>
${ simplex3D }

#define MAX_STEPS 64

uniform sampler2D uDepth;
uniform sampler2D uColumn;
uniform sampler2D uTerrain;
uniform mat4 uProjectionInverse;
uniform mat4 uCameraWorld;
uniform vec3 uCameraPosition;
uniform float uWorldSize;
uniform vec2 uSlab;
uniform vec4 uBounds; // 水平の範囲 minX, minZ, maxX, maxZ
uniform float uBoundsFade;
uniform float uMaxDistance;
uniform int uSteps;
uniform float uOpacity;
uniform float uFalloff;
uniform float uNoise;
uniform float uTime;
uniform vec2 uWind;
uniform vec2 uSceneFog;

varying vec2 vUv;

void main() {

	// このピクセルの視線と、シーン (地面・物体) までの距離
	float depth = texture2D( uDepth, vUv ).x;
	vec4 view = uProjectionInverse * vec4( vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0 );
	view.xyz /= view.w;
	float sceneDistance = depth >= 1.0 ? 1e6 : length( view.xyz );
	float viewDepth = depth >= 1.0 ? 1e4 : - view.z;
	vec3 direction = normalize( ( uCameraWorld * vec4( normalize( view.xyz ), 0.0 ) ).xyz );

	// 霧が存在しうる箱 (水平は uBounds、高さは uSlab) と重なる区間だけを進む
	// 箱の外のピクセルはここで終わり、箱の中も霧のある所だけを細かく進める
	vec3 boxMin = vec3( uBounds.x, uSlab.x, uBounds.y );
	vec3 boxMax = vec3( uBounds.z, uSlab.y, uBounds.w );
	vec3 inverse = 1.0 / ( abs( direction ) + 1e-6 ) * sign( direction + 1e-12 );
	vec3 t0 = ( boxMin - uCameraPosition ) * inverse;
	vec3 t1 = ( boxMax - uCameraPosition ) * inverse;
	vec3 tMin = min( t0, t1 );
	vec3 tMax = max( t0, t1 );

	float near = max( max( tMin.x, tMin.y ), max( tMin.z, 0.0 ) );
	float far = min( min( tMax.x, tMax.y ), min( tMax.z, min( uMaxDistance, sceneDistance ) ) );

	if ( far <= near ) {

		gl_FragColor = vec4( 0.0, 0.0, viewDepth, 1.0 );
		return;

	}

	// 歩数が少ないと縞が出るので、開始位置をピクセルごとにずらす (interleaved gradient noise)
	float jitter = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
	float stepLength = ( far - near ) / float( uSteps );

	// 色は明るさ b について線形 ( mix( low, high, b ) ) なので、Σ寄与 と Σ寄与 * b だけを積算し、
	// 色の組み立ては合成パスで行う (出力の 1 チャンネルを低解像度の深度に使うため)
	float transmittance = 1.0;
	float opacitySum = 0.0;
	float brightnessSum = 0.0;
	float weightedDistance = 0.0;
	vec2 drift = uWind * uTime;

	for ( int i = 0; i < MAX_STEPS; i ++ ) {

		if ( i >= uSteps ) break;

		float t = near + ( float( i ) + jitter ) * stepLength;
		vec3 position = uCameraPosition + direction * t;
		vec2 uv = position.xz / uWorldSize + 0.5;

		if ( uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 ) continue;

		vec4 column = texture2D( uColumn, uv );
		float top = column.x;
		float h = position.y - texture2D( uTerrain, uv ).x;

		if ( h < 0.0 || h >= top || top < 1e-3 ) continue;

		// 地面ほど濃く上ほど薄い分布。高さ方向に積分すると光学的な厚み W (column.y) になる
		float s = h / top;
		float density = column.y / top * ( uFalloff + 1.0 ) * pow( 1.0 - s, uFalloff );

		// 3D ノイズで高さ方向にもムラを付ける (板状に見えないように)
		float n = snoise( vec3( ( position.xz - drift * 1.4 ) * 0.3, position.y * 0.9 - uTime * 0.15 ) );
		density *= max( 1.0 + n * uNoise, 0.0 );

		// 範囲の縁で滑らかに消す
		vec2 edge = min( position.xz - uBounds.xy, uBounds.zw - position.xz );
		density *= smoothstep( 0.0, uBoundsFade, min( edge.x, edge.y ) );

		float alpha = 1.0 - exp( - uOpacity * density * stepLength );

		// 上の方ほど明るい
		float brightness = clamp( 0.3 + 0.45 * s + column.z, 0.0, 1.0 );

		float contribution = transmittance * alpha;
		opacitySum += contribution;
		brightnessSum += contribution * brightness;
		weightedDistance += contribution * t;
		transmittance *= 1.0 - alpha;

		if ( transmittance < 0.01 ) break;

	}

	// シーンの距離フォグ (THREE.Fog) を霧にも掛ける: 遠くの霧ほど背景に溶ける
	float opacity = 1.0 - transmittance;
	float distance = opacity > 1e-4 ? weightedDistance / opacity : far;
	float sceneFog = clamp( ( distance - uSceneFog.x ) / ( uSceneFog.y - uSceneFog.x ), 0.0, 1.0 );

	// r: Σ寄与, g: Σ寄与 * 明るさ, b: このピクセルのシーンまでの距離 (view 空間の深さ), a: 透過率
	gl_FragColor = vec4( vec2( opacitySum, brightnessSum ) * ( 1.0 - sceneFog ), viewDepth, mix( transmittance, 1.0, sceneFog ) );

}
`;

const compositeFragmentShader = /* glsl */`
#include <packing>

uniform sampler2D uScene;
uniform sampler2D uDepth;
uniform sampler2D uFogTexture;
uniform vec2 uFogSize;
uniform float uCameraNear;
uniform float uCameraFar;
uniform vec3 uColorLow;
uniform vec3 uColorHigh;

varying vec2 vUv;

void main() {

	// 霧は低解像度なので、周囲 3x3 のテクセルを深度の近いものだけ重みを付けて平均しながら拡大する
	// (物体の輪郭に霧がにじまないように。歩数を減らすためのずらしのノイズもここで均す)
	// 低解像度側の深度は霧パスが b チャンネルに入れているので、全解像度の深度は自分の 1 回だけ読む
	float depth = - perspectiveDepthToViewZ( texture2D( uDepth, vUv ).x, uCameraNear, uCameraFar );
	vec2 center = floor( vUv * uFogSize ) + 0.5;
	vec2 position = vUv * uFogSize;

	vec4 fog = vec4( 0.0 );
	float total = 0.0;

	for ( int y = - 1; y <= 1; y ++ ) {

		for ( int x = - 1; x <= 1; x ++ ) {

			vec2 texel = center + vec2( float( x ), float( y ) );
			vec4 fogTexel = texture2D( uFogTexture, texel / uFogSize );
			vec2 d = texel - position;
			float spatial = exp( - dot( d, d ) * 0.7 );
			float weight = spatial / ( 1e-2 + abs( fogTexel.b - depth ) / depth * 20.0 );
			fog += fogTexel * weight;
			total += weight;

		}

	}

	fog /= max( total, 1e-5 );
	vec3 fogColor = uColorLow * fog.r + ( uColorHigh - uColorLow ) * fog.g;

	// シーンだけトーンマッピングし、霧は表示用の色としてその上に重ねる
	// (4 層版と同じ見た目の色にするため)
	gl_FragColor = vec4( texture2D( uScene, vUv ).rgb, 1.0 );

	#include <tonemapping_fragment>
	#include <colorspace_fragment>

	gl_FragColor.rgb = gl_FragColor.rgb * fog.a + fogColor;

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

	return { texture, data, resolution, size, minHeight, maxHeight };

}

export class VolumetricFog {

	constructor( renderer, simulation, { resolutionScale = 0.5, columnResolution = 512, samples = 2 } = {} ) {

		this.renderer = renderer;
		this.simulation = simulation;
		this.resolutionScale = resolutionScale;

		const size = simulation.worldSize;
		const terrain = createTerrainTexture( size, columnResolution );
		this._terrain = terrain;
		this._wind = new Vector2( 0.35, 0.12 );

		// 霧を出す水平の範囲 (x, z)。既定はシミュレーションの範囲全体
		// 変更したら updateBounds() を呼ぶ
		const half = size / 2;
		this.bounds = new Box2( new Vector2( - half, - half ), new Vector2( half, half ) );
		this.boundsBox = new Box3();
		this._slab = new Vector2();

		// 1. 柱パス
		this._columnTarget = new WebGLRenderTarget( columnResolution, columnResolution, {
			type: HalfFloatType,
			format: RGBAFormat,
			minFilter: LinearFilter,
			magFilter: LinearFilter,
			wrapS: ClampToEdgeWrapping,
			wrapT: ClampToEdgeWrapping,
			depthBuffer: false,
		} );
		this.columnMaterial = new ShaderMaterial( {
			vertexShader: quadVertexShader,
			fragmentShader: columnFragmentShader,
			uniforms: {
				uFog: { value: null },
				uVelocity: { value: null },
				uCurl: { value: null },
				uTerrain: { value: terrain.texture },
				uTerrainTexel: { value: new Vector2( 1 / columnResolution, 1 / columnResolution ) },
				// ぼかしの半径は 4 層版 (256 解像度) と同じ実寸にする
				uBlurTexel: { value: new Vector2( 1 / 256, 1 / 256 ) },
				uFogTexel: { value: new Vector2( 1 / simulation.resolution, 1 / simulation.resolution ) },
				uWorldSize: { value: size },
				uTime: { value: 0 },
				uWind: { value: this._wind },
				uHeightRange: { value: new Vector2( terrain.minHeight, terrain.maxHeight ) },
				uThickness: { value: 1.4 },
				uDistortion: { value: 0.2 },
				uLift: { value: 0.25 },
				uResidual: { value: 0.15 },
				uSwirlDetail: { value: 0.6 },
			},
			depthTest: false,
			depthWrite: false,
		} );
		this._columnQuad = new FullScreenQuad( this.columnMaterial );

		// 2. シーン (色 + 深度)
		this._sceneTarget = new WebGLRenderTarget( 1, 1, {
			type: HalfFloatType,
			samples,
			depthTexture: new DepthTexture( 1, 1 ),
		} );
		this._sceneTarget.depthTexture.minFilter = NearestFilter;
		this._sceneTarget.depthTexture.magFilter = NearestFilter;

		// 3. 霧パス (低解像度)
		this._fogTarget = new WebGLRenderTarget( 1, 1, {
			type: HalfFloatType,
			format: RGBAFormat,
			minFilter: NearestFilter,
			magFilter: NearestFilter,
			depthBuffer: false,
		} );
		this.marchMaterial = new ShaderMaterial( {
			vertexShader: quadVertexShader,
			fragmentShader: marchFragmentShader,
			uniforms: {
				uDepth: { value: this._sceneTarget.depthTexture },
				uColumn: { value: this._columnTarget.texture },
				uTerrain: { value: terrain.texture },
				uProjectionInverse: { value: null },
				uCameraWorld: { value: null },
				uCameraPosition: { value: new Vector3() },
				uWorldSize: { value: size },
				uSlab: { value: new Vector2() },
				uBounds: { value: new Vector4() },
				uBoundsFade: { value: 2 },
				uMaxDistance: { value: 70 },
				uSteps: { value: 32 },
				uOpacity: { value: 1.4 },
				uFalloff: { value: 1.5 },
				uNoise: { value: 0.5 },
				uTime: { value: 0 },
				uWind: { value: this._wind },
				uSceneFog: { value: new Vector2( 30, 70 ) },
			},
			depthTest: false,
			depthWrite: false,
		} );
		this._marchQuad = new FullScreenQuad( this.marchMaterial );

		// 4. 合成
		this._compositeMaterial = new ShaderMaterial( {
			vertexShader: quadVertexShader,
			fragmentShader: compositeFragmentShader,
			uniforms: {
				uScene: { value: this._sceneTarget.texture },
				uDepth: { value: this._sceneTarget.depthTexture },
				uFogTexture: { value: this._fogTarget.texture },
				uFogSize: { value: new Vector2( 1, 1 ) },
				uCameraNear: { value: 0.1 },
				uCameraFar: { value: 500 },
				uColorLow: { value: new Color( 0x968daf ) },
				uColorHigh: { value: new Color( 0xf0ecf7 ) },
			},
			depthTest: false,
			depthWrite: false,
		} );
		this._compositeQuad = new FullScreenQuad( this._compositeMaterial );

		// GUI 用
		this.colorLow = this._compositeMaterial.uniforms.uColorLow.value;
		this.colorHigh = this._compositeMaterial.uniforms.uColorHigh.value;

	}

	get steps() {

		return this.marchMaterial.uniforms.uSteps.value;

	}

	set steps( value ) {

		this.marchMaterial.uniforms.uSteps.value = value;

	}

	// bounds を反映する。範囲はシミュレーションの範囲に収め、
	// 範囲内の地形の最低点・最高点から霧の高さの範囲を求め直す (区間が狭いほど霧パスが軽い)
	updateBounds() {

		const half = this.simulation.worldSize / 2;
		const bounds = this.bounds;
		const minX = Math.max( bounds.min.x, - half );
		const minZ = Math.max( bounds.min.y, - half );
		const maxX = Math.min( bounds.max.x, half );
		const maxZ = Math.min( bounds.max.y, half );

		// 範囲内の地形の高さの範囲は、範囲が変わったときだけ求め直す
		const key = `${ minX },${ minZ },${ maxX },${ maxZ }`;

		if ( key !== this._boundsKey ) {

			this._boundsKey = key;

			const { data, resolution, size } = this._terrain;
			const toIndex = ( v ) => Math.min( resolution - 1, Math.max( 0, Math.floor( ( v / size + 0.5 ) * resolution ) ) );
			let low = Infinity;
			let high = - Infinity;

			for ( let y = toIndex( minZ ); y <= toIndex( maxZ ); y ++ ) {

				for ( let x = toIndex( minX ); x <= toIndex( maxX ); x ++ ) {

					const height = DataUtils.fromHalfFloat( data[ y * resolution + x ] );
					low = Math.min( low, height );
					high = Math.max( high, height );

				}

			}

			this._groundRange = low > high ? [ 0, 0 ] : [ low, high ];

		}

		const [ minHeight, maxHeight ] = this._groundRange;

		const column = this.columnMaterial.uniforms;
		const maxTop = column.uThickness.value * 1.5 + column.uDistortion.value + 0.1;
		this._slab.set( minHeight - 0.1, maxHeight + maxTop );

		this.marchMaterial.uniforms.uBounds.value.set( minX, minZ, maxX, maxZ );
		this.boundsBox.min.set( minX, this._slab.x, minZ );
		this.boundsBox.max.set( maxX, this._slab.y, maxZ );

	}

	setSize( width, height ) {

		const pixelRatio = this.renderer.getPixelRatio();
		const w = Math.floor( width * pixelRatio );
		const h = Math.floor( height * pixelRatio );
		this._sceneTarget.setSize( w, h );

		const fw = Math.max( 1, Math.floor( w * this.resolutionScale ) );
		const fh = Math.max( 1, Math.floor( h * this.resolutionScale ) );
		this._fogTarget.setSize( fw, fh );
		this._compositeMaterial.uniforms.uFogSize.value.set( fw, fh );

	}

	setResolutionScale( value ) {

		this.resolutionScale = value;
		const size = this.renderer.getSize( new Vector2() );
		this.setSize( size.x, size.y );

	}

	render( scene, camera, time ) {

		const renderer = this.renderer;
		const previousTarget = renderer.getRenderTarget();

		// 1. 柱パス
		const column = this.columnMaterial.uniforms;
		column.uTime.value = time;
		column.uFog.value = this.simulation.fogTexture;
		column.uVelocity.value = this.simulation.velocityTexture;
		column.uCurl.value = this.simulation.curlTexture;
		renderer.setRenderTarget( this._columnTarget );
		this._columnQuad.render( renderer );

		// 2. シーン
		renderer.setRenderTarget( this._sceneTarget );
		renderer.render( scene, camera );

		// 3. 霧パス
		const march = this.marchMaterial.uniforms;
		march.uTime.value = time;
		march.uProjectionInverse.value = camera.projectionMatrixInverse;
		march.uCameraWorld.value = camera.matrixWorld;
		march.uCameraPosition.value.setFromMatrixPosition( camera.matrixWorld );

		// 霧が存在しうる箱 (厚みや歪みは GUI で変わるので毎フレーム求め直す)
		this.updateBounds();
		march.uSlab.value.copy( this._slab );

		if ( scene.fog ) march.uSceneFog.value.set( scene.fog.near, scene.fog.far );

		renderer.setRenderTarget( this._fogTarget );
		this._marchQuad.render( renderer );

		// 4. 合成
		const composite = this._compositeMaterial.uniforms;
		composite.uCameraNear.value = camera.near;
		composite.uCameraFar.value = camera.far;
		renderer.setRenderTarget( previousTarget );
		this._compositeQuad.render( renderer );

	}

	dispose() {

		this._columnTarget.dispose();
		this._sceneTarget.dispose();
		this._fogTarget.dispose();
		this.columnMaterial.dispose();
		this.marchMaterial.dispose();
		this._compositeMaterial.dispose();
		this._columnQuad.dispose();
		this._marchQuad.dispose();
		this._compositeQuad.dispose();
		this._terrain.texture.dispose();

	}

}
