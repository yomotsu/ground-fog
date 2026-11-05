import {
	ClampToEdgeWrapping,
	Color,
	HalfFloatType,
	LinearFilter,
	RGBAFormat,
	ShaderMaterial,
	Vector2,
	Vector4,
	WebGLRenderTarget,
} from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { simplex3D } from './glsl/simplex3D.js';

const MAX_BLASTS = 8;

// 地面 (xz 平面) 上の 2D stable fluids
// テクスチャの u が world x、v が world z に対応し、速度は world 単位 (m/s) で持つ
//
// velocity : xy = 速度 (vx, vz)
// fog      : xy = ノイズ座標のオフセット (流れで運ばれる)、z = 霧の濃度
// divergence : x = 発散 - 湧き出し、y = 湧き出し量

const vertexShader = /* glsl */`
varying vec2 vUv;

void main() {

	vUv = uv;
	gl_Position = vec4( position.xy, 0.0, 1.0 );

}
`;

const commonUniforms = /* glsl */`
varying vec2 vUv;
uniform vec2 uTexel;
uniform float uWorldSize;
uniform float uDt;
`;

const advectVelocityShader = /* glsl */`
${ commonUniforms }
uniform sampler2D uVelocity;
uniform float uDissipation;

void main() {

	vec2 velocity = texture2D( uVelocity, vUv ).xy;
	vec2 previous = vUv - velocity * uDt / uWorldSize;
	vec2 result = texture2D( uVelocity, previous ).xy * exp( - uDissipation * uDt );
	gl_FragColor = vec4( result, 0.0, 1.0 );

}
`;

const curlShader = /* glsl */`
${ commonUniforms }
uniform sampler2D uVelocity;

void main() {

	float cell = uWorldSize * uTexel.x;
	float l = texture2D( uVelocity, vUv - vec2( uTexel.x, 0.0 ) ).y;
	float r = texture2D( uVelocity, vUv + vec2( uTexel.x, 0.0 ) ).y;
	float b = texture2D( uVelocity, vUv - vec2( 0.0, uTexel.y ) ).x;
	float t = texture2D( uVelocity, vUv + vec2( 0.0, uTexel.y ) ).x;
	float curl = ( ( r - l ) - ( t - b ) ) / ( 2.0 * cell );
	gl_FragColor = vec4( curl, 0.0, 0.0, 1.0 );

}
`;

// 渦度強調 + 環境のゆるい curl noise 風 + ドラッグの外力 + 吹き飛ばしの前向きの勢い
const forceShader = /* glsl */`
${ commonUniforms }
${ simplex3D }
uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform vec4 uBlasts[ ${ MAX_BLASTS } ];
uniform vec4 uBlastShapes[ ${ MAX_BLASTS } ];
uniform float uBlastPush;
uniform float uBlastWidth;
uniform float uTime;
uniform float uVorticity;
uniform float uAmbient;
uniform vec4 uDrag; // xy = world 位置, zw = 速度
uniform float uDragRadius;

vec2 curlNoise( vec2 p ) {

	const float e = 0.5;
	float n = snoise( vec3( p.x, p.y + e, uTime * 0.05 ) );
	float s = snoise( vec3( p.x, p.y - e, uTime * 0.05 ) );
	float east = snoise( vec3( p.x + e, p.y, uTime * 0.05 ) );
	float west = snoise( vec3( p.x - e, p.y, uTime * 0.05 ) );
	return vec2( n - s, - ( east - west ) ) / ( 2.0 * e );

}

void main() {

	vec2 velocity = texture2D( uVelocity, vUv ).xy;

	float l = texture2D( uCurl, vUv - vec2( uTexel.x, 0.0 ) ).x;
	float r = texture2D( uCurl, vUv + vec2( uTexel.x, 0.0 ) ).x;
	float b = texture2D( uCurl, vUv - vec2( 0.0, uTexel.y ) ).x;
	float t = texture2D( uCurl, vUv + vec2( 0.0, uTexel.y ) ).x;
	float c = texture2D( uCurl, vUv ).x;

	vec2 force = vec2( abs( t ) - abs( b ), abs( r ) - abs( l ) );
	force /= length( force ) + 1e-5;
	force *= uVorticity * c * vec2( 1.0, - 1.0 );

	vec2 world = ( vUv - 0.5 ) * uWorldSize;
	force += curlNoise( world * 0.06 ) * uAmbient;

	vec2 d = world - uDrag.xy;
	velocity += uDrag.zw * exp( - dot( d, d ) / ( uDragRadius * uDragRadius ) );

	// 湧き出しだけだと後ろにも流れるので、前向きのジェットを足す
	for ( int i = 0; i < ${ MAX_BLASTS }; i ++ ) {

		vec4 blast = uBlasts[ i ];
		if ( blast.w <= 0.0 ) continue;

		vec2 forward = uBlastShapes[ i ].xy;
		vec2 side = vec2( - forward.y, forward.x );
		// 湧き出しの後ろ (クリック地点) を中心にして、後ろへの逆流を打ち消す
		vec2 b = world - ( blast.xy + forward * blast.z * 0.7 );
		vec2 local = vec2( dot( b, forward ), dot( b, side ) ) / ( blast.z * vec2( 1.6, uBlastWidth ) );
		force += forward * blast.w * uBlastPush * exp( - dot( local, local ) );

	}

	velocity += force * uDt;
	gl_FragColor = vec4( velocity, 0.0, 1.0 );

}
`;

// 発散。クリック地点は「振り下ろした剣の風圧が地表で前方へ広がる」湧き出しとして扱う
// 前方の扇状 (弧) に同量の吸い込みを置き、その弧を少し前まで進めることで、
// 霧が前方へ吹き飛ばされて弧の位置に溜まる
const divergenceShader = /* glsl */`
${ commonUniforms }
${ simplex3D }
uniform sampler2D uVelocity;
uniform vec4 uBlasts[ ${ MAX_BLASTS } ]; // xy = world 位置, z = 半径, w = 強さ (1/s)
uniform vec4 uBlastShapes[ ${ MAX_BLASTS } ]; // xy = 前方向, z = 弧の半径
uniform float uRingWidth;
uniform float uBlastWidth;
uniform float uArcPower;
uniform float uArcNorm;
uniform float uTime;

void main() {

	float cell = uWorldSize * uTexel.x;
	vec2 c = texture2D( uVelocity, vUv ).xy;
	float l = texture2D( uVelocity, vUv - vec2( uTexel.x, 0.0 ) ).x;
	float r = texture2D( uVelocity, vUv + vec2( uTexel.x, 0.0 ) ).x;
	float b = texture2D( uVelocity, vUv - vec2( 0.0, uTexel.y ) ).y;
	float t = texture2D( uVelocity, vUv + vec2( 0.0, uTexel.y ) ).y;

	// 境界は壁 (法線方向の速度を反転)
	if ( vUv.x - uTexel.x < 0.0 ) l = - c.x;
	if ( vUv.x + uTexel.x > 1.0 ) r = - c.x;
	if ( vUv.y - uTexel.y < 0.0 ) b = - c.y;
	if ( vUv.y + uTexel.y > 1.0 ) t = - c.y;

	float divergence = ( ( r - l ) + ( t - b ) ) / ( 2.0 * cell );

	vec2 world = ( vUv - 0.5 ) * uWorldSize;
	float source = 0.0;

	for ( int i = 0; i < ${ MAX_BLASTS }; i ++ ) {

		vec4 blast = uBlasts[ i ];
		if ( blast.w <= 0.0 ) continue;

		vec4 shape = uBlastShapes[ i ];
		vec2 forward = shape.xy;
		vec2 side = vec2( - forward.y, forward.x );

		vec2 d = world - blast.xy;
		float distance = length( d );
		vec2 direction = d / ( distance + 1e-3 );

		// 湧き出し: 後端がクリック地点に来る、前後に長い楕円
		float along = blast.z * 1.4;
		float across = blast.z * 0.7 * uBlastWidth;
		vec2 local = vec2( dot( d, forward ) - along, dot( d, side ) );
		float falloff = exp( - dot( local / vec2( along, across ), local / vec2( along, across ) ) );
		// ガウスの裾がクリック地点より後ろの霧を削らないようにする
		falloff *= smoothstep( - 0.2, 0.3, dot( d, forward ) / blast.z );

		// 吸い込み: 前方の弧 (cos^n の角度窓。uBlastWidth = 1 で cos^2 ≒ ±60°)
		// 総量 ∫ = R * w√π * ∫cos^n が湧き出し π * along * across と釣り合う強さにする
		// uArcNorm = π / ∫cos^n
		float arcRadius = shape.z;
		float width = blast.z * uRingWidth;
		float arcOffset = ( distance - arcRadius ) / width;
		float facing = max( dot( direction, forward ), 0.0 );
		float arc = exp( - arcOffset * arcOffset ) * pow( facing, uArcPower );
		float arcStrength = uArcNorm * along * across / ( arcRadius * width * 1.7725 );

		// 角度方向にムラを付けて、きれいな扇形にならないようにする
		float jitter = 1.0 + 0.6 * snoise( vec3( direction * 2.0, blast.x * 0.37 + blast.y * 0.71 ) );
		source += blast.w * ( falloff - arc * arcStrength ) * jitter;

	}

	gl_FragColor = vec4( divergence - source, source, 0.0, 1.0 );

}
`;

const pressureShader = /* glsl */`
${ commonUniforms }
uniform sampler2D uPressure;
uniform sampler2D uDivergence;

void main() {

	float cell = uWorldSize * uTexel.x;
	float l = texture2D( uPressure, vUv - vec2( uTexel.x, 0.0 ) ).x;
	float r = texture2D( uPressure, vUv + vec2( uTexel.x, 0.0 ) ).x;
	float b = texture2D( uPressure, vUv - vec2( 0.0, uTexel.y ) ).x;
	float t = texture2D( uPressure, vUv + vec2( 0.0, uTexel.y ) ).x;
	float divergence = texture2D( uDivergence, vUv ).x;
	float pressure = ( l + r + b + t - divergence * cell * cell ) * 0.25;
	gl_FragColor = vec4( pressure, 0.0, 0.0, 1.0 );

}
`;

const scaleShader = /* glsl */`
${ commonUniforms }
uniform sampler2D uSource;
uniform float uScale;

void main() {

	gl_FragColor = vec4( texture2D( uSource, vUv ).xyz * uScale, 1.0 );

}
`;

const gradientSubtractShader = /* glsl */`
${ commonUniforms }
uniform sampler2D uPressure;
uniform sampler2D uVelocity;

void main() {

	float cell = uWorldSize * uTexel.x;
	float l = texture2D( uPressure, vUv - vec2( uTexel.x, 0.0 ) ).x;
	float r = texture2D( uPressure, vUv + vec2( uTexel.x, 0.0 ) ).x;
	float b = texture2D( uPressure, vUv - vec2( 0.0, uTexel.y ) ).x;
	float t = texture2D( uPressure, vUv + vec2( 0.0, uTexel.y ) ).x;
	vec2 velocity = texture2D( uVelocity, vUv ).xy;
	velocity -= vec2( r - l, t - b ) / ( 2.0 * cell );
	gl_FragColor = vec4( velocity, 0.0, 1.0 );

}
`;

// 霧フィールドの移流
// 濃度は連続の式 dD/dt = -u・∇D - D ∇・u の湧き出し分で増減させ、ゆっくり 1 に戻す
// ノイズ座標オフセットも流れで運び、ゆっくり 0 に戻す
const advectFogShader = /* glsl */`
${ commonUniforms }
uniform sampler2D uVelocity;
uniform sampler2D uFog;
uniform sampler2D uDivergence;
uniform float uDensityRecovery;
uniform float uOffsetRecovery;
uniform float uMaxDensity;

void main() {

	vec2 velocity = texture2D( uVelocity, vUv ).xy;
	vec2 previous = vUv - velocity * uDt / uWorldSize;
	vec4 fog = texture2D( uFog, previous );

	vec2 offset = fog.xy - velocity * uDt;
	offset *= exp( - uOffsetRecovery * uDt );

	float source = texture2D( uDivergence, vUv ).y;
	float density = min( fog.z * exp( - source * uDt ), uMaxDensity );
	density = mix( 1.0, density, exp( - uDensityRecovery * uDt ) );

	gl_FragColor = vec4( offset, density, 1.0 );

}
`;

function createTarget( resolution ) {

	return new WebGLRenderTarget( resolution, resolution, {
		type: HalfFloatType,
		format: RGBAFormat,
		minFilter: LinearFilter,
		magFilter: LinearFilter,
		wrapS: ClampToEdgeWrapping,
		wrapT: ClampToEdgeWrapping,
		depthBuffer: false,
	} );

}

class DoubleTarget {

	constructor( resolution ) {

		this.read = createTarget( resolution );
		this.write = createTarget( resolution );

	}

	swap() {

		const temp = this.read;
		this.read = this.write;
		this.write = temp;

	}

	dispose() {

		this.read.dispose();
		this.write.dispose();

	}

}

export class FogSimulation {

	constructor( renderer, { resolution = 256, worldSize = 96 } = {} ) {

		this.renderer = renderer;
		this.resolution = resolution;
		this.worldSize = worldSize;

		this.params = {
			pressureIterations: 40,
			velocityDissipation: 0.6,
			vorticity: 6,
			ambient: 0.6,
			densityRecovery: 0.12,
			offsetRecovery: 0.08,
			blastStrength: 24,
			blastRadius: 1.1,
			blastDuration: 0.35,
			ringStart: 2,
			reach: 1.2,
			blastPush: 1.4,
			blastWidth: 1,
			ringWidth: 0.8,
			maxDensity: 2.5,
			dragRadius: 1.5,
		};

		this.velocity = new DoubleTarget( resolution );
		this.fog = new DoubleTarget( resolution );
		this.pressure = new DoubleTarget( resolution );
		this.divergence = createTarget( resolution );
		this.curl = createTarget( resolution );

		this._time = 0;
		this._blasts = [];
		this._blastUniforms = [];
		this._blastShapes = [];

		for ( let i = 0; i < MAX_BLASTS; i ++ ) {

			this._blastUniforms.push( new Vector4() );
			this._blastShapes.push( new Vector4() );

		}

		this._drag = new Vector4();
		this._quad = new FullScreenQuad();

		const texel = new Vector2( 1 / resolution, 1 / resolution );
		const create = ( fragmentShader, uniforms ) => new ShaderMaterial( {
			vertexShader,
			fragmentShader,
			uniforms: {
				uTexel: { value: texel },
				uWorldSize: { value: worldSize },
				uDt: { value: 0 },
				...uniforms,
			},
			depthTest: false,
			depthWrite: false,
		} );

		this._advectVelocity = create( advectVelocityShader, {
			uVelocity: { value: null },
			uDissipation: { value: 0 },
		} );
		this._curl = create( curlShader, {
			uVelocity: { value: null },
		} );
		this._force = create( forceShader, {
			uVelocity: { value: null },
			uCurl: { value: null },
			uTime: { value: 0 },
			uVorticity: { value: 0 },
			uAmbient: { value: 0 },
			uDrag: { value: this._drag },
			uDragRadius: { value: 1 },
			uBlasts: { value: this._blastUniforms },
			uBlastShapes: { value: this._blastShapes },
			uBlastPush: { value: 0 },
			uBlastWidth: { value: 1 },
		} );
		this._divergence = create( divergenceShader, {
			uVelocity: { value: null },
			uBlasts: { value: this._blastUniforms },
			uBlastShapes: { value: this._blastShapes },
			uRingWidth: { value: 1 },
			uBlastWidth: { value: 1 },
			uArcPower: { value: 2 },
			uArcNorm: { value: 2 },
			uTime: { value: 0 },
		} );
		this._pressure = create( pressureShader, {
			uPressure: { value: null },
			uDivergence: { value: null },
		} );
		this._scale = create( scaleShader, {
			uSource: { value: null },
			uScale: { value: 1 },
		} );
		this._gradientSubtract = create( gradientSubtractShader, {
			uPressure: { value: null },
			uVelocity: { value: null },
		} );
		this._advectFog = create( advectFogShader, {
			uVelocity: { value: null },
			uFog: { value: null },
			uDivergence: { value: null },
			uDensityRecovery: { value: 0 },
			uOffsetRecovery: { value: 0 },
			uMaxDensity: { value: 1 },
		} );

		this.reset();

	}

	get velocityTexture() {

		return this.velocity.read.texture;

	}

	get fogTexture() {

		return this.fog.read.texture;

	}

	reset() {

		const renderer = this.renderer;
		const previousTarget = renderer.getRenderTarget();
		const previousColor = renderer.getClearColor( new Color() );
		const previousAlpha = renderer.getClearAlpha();

		const clear = ( target, color ) => {

			renderer.setRenderTarget( target );
			renderer.setClearColor( color, 1 );
			renderer.clear( true, false, false );

		};

		const zero = new Color( 0, 0, 0 );

		for ( const target of [ this.velocity.read, this.velocity.write, this.pressure.read, this.pressure.write, this.divergence, this.curl ] ) {

			clear( target, zero );

		}

		// 濃度 1 で初期化
		const fog = new Color( 0, 0, 1 );
		clear( this.fog.read, fog );
		clear( this.fog.write, fog );

		renderer.setRenderTarget( previousTarget );
		renderer.setClearColor( previousColor, previousAlpha );
		this._blasts = [];
		this._drag.set( 0, 0, 0, 0 );

	}

	// クリック地点から (dirX, dirZ) 方向へ霧を吹き飛ばす
	blast( x, z, dirX, dirZ ) {

		const length = Math.hypot( dirX, dirZ ) || 1;
		this._blasts.push( { x, z, dirX: dirX / length, dirZ: dirZ / length, age: 0 } );

		if ( this._blasts.length > MAX_BLASTS ) this._blasts.shift();

	}

	// ドラッグで流れを加える (velocity: m/s)
	drag( x, z, vx, vz ) {

		this._drag.set( x, z, vx, vz );

	}

	update( dt ) {

		const params = this.params;
		this._time += dt;

		// blast の寿命管理
		for ( let i = 0; i < MAX_BLASTS; i ++ ) {

			const blast = this._blasts[ i ];
			const uniform = this._blastUniforms[ i ];

			if ( blast === undefined ) {

				uniform.set( 0, 0, 1, 0 );
				continue;

			}

			const decay = Math.exp( - blast.age / params.blastDuration );
			uniform.set( blast.x, blast.z, params.blastRadius, params.blastStrength * decay );
			// 弧は減速しながら前へ進み、reach だけ進んだところで止まる
			const arcRadius = params.blastRadius * params.ringStart + params.reach * ( 1 - decay );
			this._blastShapes[ i ].set( blast.dirX, blast.dirZ, arcRadius, 0 );
			blast.age += dt;

		}

		this._blasts = this._blasts.filter( ( blast ) => blast.age < params.blastDuration * 6 );

		for ( const material of [ this._advectVelocity, this._curl, this._force, this._divergence, this._pressure, this._scale, this._gradientSubtract, this._advectFog ] ) {

			material.uniforms.uDt.value = dt;

		}

		// 1. 渦度
		this._curl.uniforms.uVelocity.value = this.velocity.read.texture;
		this._render( this._curl, this.curl );

		// 2. 外力 (渦度強調 + 環境風 + ドラッグ)
		const force = this._force.uniforms;
		force.uVelocity.value = this.velocity.read.texture;
		force.uCurl.value = this.curl.texture;
		force.uTime.value = this._time;
		force.uVorticity.value = params.vorticity;
		force.uAmbient.value = params.ambient;
		force.uDragRadius.value = params.dragRadius;
		force.uBlastPush.value = params.blastPush;
		force.uBlastWidth.value = params.blastWidth;
		this._render( this._force, this.velocity.write );
		this.velocity.swap();
		this._drag.set( 0, 0, 0, 0 );

		// 3. 発散 (湧き出し込み)
		this._divergence.uniforms.uVelocity.value = this.velocity.read.texture;
		this._divergence.uniforms.uTime.value = this._time;
		this._divergence.uniforms.uRingWidth.value = params.ringWidth;
		this._divergence.uniforms.uBlastWidth.value = params.blastWidth;
		this._updateArc( params.blastWidth );
		this._render( this._divergence, this.divergence );

		// 4. 圧力 (前フレームの値を減衰させて初期値に使う)
		this._scale.uniforms.uSource.value = this.pressure.read.texture;
		this._scale.uniforms.uScale.value = 0.8;
		this._render( this._scale, this.pressure.write );
		this.pressure.swap();

		this._pressure.uniforms.uDivergence.value = this.divergence.texture;

		for ( let i = 0; i < params.pressureIterations; i ++ ) {

			this._pressure.uniforms.uPressure.value = this.pressure.read.texture;
			this._render( this._pressure, this.pressure.write );
			this.pressure.swap();

		}

		// 5. 投影
		this._gradientSubtract.uniforms.uPressure.value = this.pressure.read.texture;
		this._gradientSubtract.uniforms.uVelocity.value = this.velocity.read.texture;
		this._render( this._gradientSubtract, this.velocity.write );
		this.velocity.swap();

		// 6. 霧の移流
		const advectFog = this._advectFog.uniforms;
		advectFog.uVelocity.value = this.velocity.read.texture;
		advectFog.uFog.value = this.fog.read.texture;
		advectFog.uDivergence.value = this.divergence.texture;
		advectFog.uDensityRecovery.value = params.densityRecovery;
		advectFog.uOffsetRecovery.value = params.offsetRecovery;
		advectFog.uMaxDensity.value = params.maxDensity;
		this._render( this._advectFog, this.fog.write );
		this.fog.swap();

		// 7. 速度の自己移流
		this._advectVelocity.uniforms.uVelocity.value = this.velocity.read.texture;
		this._advectVelocity.uniforms.uDissipation.value = params.velocityDissipation;
		this._render( this._advectVelocity, this.velocity.write );
		this.velocity.swap();

	}

	// 弧の角度窓 cos^n を blastWidth に合わせる
	// cos^2 の半値角 45° を blastWidth 倍した角度で半値になる n と、その正規化係数を求める
	_updateArc( blastWidth ) {

		if ( this._arcWidth === blastWidth ) return;

		this._arcWidth = blastWidth;

		const halfAngle = Math.PI / 4 * Math.min( Math.max( blastWidth, 0.05 ), 1.9 );
		const power = Math.log( 0.5 ) / Math.log( Math.cos( halfAngle ) );

		const steps = 256;
		let integral = 0;

		for ( let i = 0; i < steps; i ++ ) {

			const angle = ( ( i + 0.5 ) / steps - 0.5 ) * Math.PI;
			integral += Math.pow( Math.cos( angle ), power ) * Math.PI / steps;

		}

		this._divergence.uniforms.uArcPower.value = power;
		this._divergence.uniforms.uArcNorm.value = Math.PI / integral;

	}

	_render( material, target ) {

		const renderer = this.renderer;
		const previousTarget = renderer.getRenderTarget();
		this._quad.material = material;
		renderer.setRenderTarget( target );
		this._quad.render( renderer );
		renderer.setRenderTarget( previousTarget );

	}

	dispose() {

		this.velocity.dispose();
		this.fog.dispose();
		this.pressure.dispose();
		this.divergence.dispose();
		this.curl.dispose();
		this._quad.dispose();

	}

}
