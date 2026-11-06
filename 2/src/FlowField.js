import {
	ClampToEdgeWrapping,
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
const MAX_DRAGS = 16;

// 流体方程式を解かず、速度場を毎ステップ式で直接組み立てる軽量版 (FogSimulation と同じインターフェース)
//
// stable fluids は圧力の反復 (Poisson 方程式) に多くのパスを使う
// ここでは発散ゼロ (または発散が式で分かる) の流れだけを足し合わせて、圧力の計算を丸ごと省く
//
//   環境の流れ   : curl noise (発散ゼロ)
//   衝撃         : ガウス分布の湧き出し + 前方の弧に並べた吸い込みのポテンシャル流 (解析解)
//   くるくる     : 弧に沿って置いたガウス渦 (発散ゼロ)。衝撃より長く残して減衰させる
//   ドラッグ     : 軌跡に置いた局所的な流れ (流れ関数から作るので発散ゼロ)。減衰させる
//
// 1 ステップ 3 パス (速度場 / 渦度 / 霧の移流)。stable fluids は 27 パス
// 代わりに、渦が流れに運ばれる・渦同士が影響し合うといった相互作用は無い
//
// velocity : xy = 速度 (vx, vz)、z = 湧き出し量 (霧の濃度の増減に使う)
// fog      : xy = ノイズ座標のオフセット、z = 霧の濃度、w = かき乱され具合

const vertexShader = /* glsl */`
varying vec2 vUv;

void main() {

	vUv = uv;
	gl_Position = vec4( position.xy, 0.0, 1.0 );

}
`;

const flowShader = /* glsl */`
${ simplex3D }

#define PI 3.14159265

varying vec2 vUv;
uniform float uWorldSize;
uniform float uTime;
uniform float uAmbient;
uniform vec4 uBlasts[ ${ MAX_BLASTS } ];      // xy = 位置, z = 半径, w = 湧き出しの強さ (1/s)。負なら逆向き (戻りの流れ)
uniform vec4 uBlastShapes[ ${ MAX_BLASTS } ]; // xy = 前方向, z = 弧の半径, w = 乱数の種
uniform float uBlastSwirls[ ${ MAX_BLASTS } ]; // 渦の強さ (m/s)
uniform float uBlastWidth;
uniform float uRingWidth;
uniform vec4 uDrags[ ${ MAX_DRAGS } ];        // xy = 位置, zw = 速度 (減衰済み)
uniform float uDragRadius;

float hash( float n ) {

	return fract( sin( n ) * 43758.5453 );

}

vec2 curlNoise( vec2 p ) {

	const float e = 0.5;
	float n = snoise( vec3( p.x, p.y + e, uTime * 0.05 ) );
	float s = snoise( vec3( p.x, p.y - e, uTime * 0.05 ) );
	float east = snoise( vec3( p.x + e, p.y, uTime * 0.05 ) );
	float west = snoise( vec3( p.x - e, p.y, uTime * 0.05 ) );
	return vec2( n - s, - ( east - west ) ) / ( 2.0 * e );

}

// 総量 flux (m^2/s) のガウス分布の湧き出し (負なら吸い込み) が作る速度。発散はガウス分布そのもの
// v( r ) = flux / ( 2π r ) * ( 1 - exp( - r^2 / R^2 ) )
vec3 source( vec2 world, vec2 center, float radius, float flux ) {

	vec2 d = world - center;
	float r2 = dot( d, d );
	float k = exp( - r2 / ( radius * radius ) );
	vec2 velocity = flux / ( 2.0 * PI ) * ( 1.0 - k ) / max( r2, 1e-4 ) * d;
	float divergence = flux / ( PI * radius * radius ) * k;
	return vec3( velocity, divergence );

}

// 点 center を中心に回るガウス渦 (spin = 1 で反時計回り)。中心から radius / √2 で最大の speed
vec2 vortex( vec2 world, vec2 center, float radius, float speed ) {

	vec2 d = world - center;
	return speed * 2.33 * vec2( - d.y, d.x ) / radius * exp( - dot( d, d ) / ( radius * radius ) );

}

// 中心付近で velocity の向きに流れ、周りを回り込んで戻る局所的な流れ
// 流れ関数 ψ = cross( velocity, d ) * G( d ) から作るので発散ゼロ
vec2 stir( vec2 world, vec2 center, vec2 velocity, float radius ) {

	vec2 d = world - center;
	float g = exp( - dot( d, d ) / ( radius * radius ) );
	float c = velocity.x * d.y - velocity.y * d.x;
	return g * ( velocity + 2.0 * c / ( radius * radius ) * vec2( - d.y, d.x ) );

}

void main() {

	vec2 world = ( vUv - 0.5 ) * uWorldSize;

	// 環境の流れ
	vec2 velocity = curlNoise( world * 0.06 ) * uAmbient;
	float divergence = 0.0;

	for ( int i = 0; i < ${ MAX_BLASTS }; i ++ ) {

		vec4 blast = uBlasts[ i ];
		float swirl = uBlastSwirls[ i ];
		if ( blast.w == 0.0 && swirl <= 0.0 ) continue;

		vec4 shape = uBlastShapes[ i ];
		vec2 forward = shape.xy;
		vec2 side = vec2( - forward.y, forward.x );
		float seed = shape.w;
		float arcRadius = shape.z;
		float halfAngle = 0.785 * uBlastWidth;

		if ( blast.w != 0.0 ) {

			// 湧き出し: クリック地点から少し前に置き、前後に 2 つ並べて前方へ伸ばす
			// 勢いが収まった後は逆向き (弧に溜まった霧が中心へ戻り、穴が埋まる)
			float flux = blast.w * PI * blast.z * blast.z * 1.4 * 0.7 * uBlastWidth;
			vec3 s = source( world, blast.xy + forward * blast.z * 0.9, blast.z * 0.8, flux * 0.5 );
			s += source( world, blast.xy + forward * blast.z * 1.9, blast.z * 0.8, flux * 0.5 );

			// 吸い込み: 前方の弧に 5 つ並べる。総量は湧き出しと同じ (霧は押し出されて弧に溜まる)
			// 弧の中央ほど強く、角度方向にクリックごとのムラを付ける
			float total = 0.0;
			vec3 sink = vec3( 0.0 );

			for ( int k = 0; k < 5; k ++ ) {

				float u = float( k ) / 4.0 * 2.0 - 1.0;
				float angle = u * halfAngle * 1.2;
				float weight = ( 1.0 - 0.6 * u * u ) * ( 0.8 + 0.4 * hash( seed + float( k ) * 1.7 ) );
				vec2 center = blast.xy + ( forward * cos( angle ) + side * sin( angle ) ) * arcRadius;
				sink += source( world, center, blast.z * uRingWidth, - weight );
				total += weight;

			}

			s += sink * flux / total;
			velocity += s.xy;
			divergence += s.z;

		}

		// くるくる: 両端に逆回転の大きな渦のペア、途中に向きがランダムな中くらいの渦
		if ( swirl > 0.0 ) {

			for ( int k = 0; k < 2; k ++ ) {

				float spin = k == 0 ? 1.0 : - 1.0;
				float angle = spin * halfAngle * ( 0.75 + 0.3 * hash( seed + float( k ) ) );
				vec2 center = blast.xy + ( forward * cos( angle ) + side * sin( angle ) ) * arcRadius * 0.85;
				velocity += vortex( world, center, blast.z * 1.5, spin * swirl );

			}

			for ( int k = 0; k < 2; k ++ ) {

				float random = hash( seed + 7.0 + float( k ) * 3.1 );
				float angle = ( random * 2.0 - 1.0 ) * halfAngle * 0.7;
				float radius = arcRadius * ( 0.55 + 0.4 * hash( seed + 11.0 + float( k ) ) );
				vec2 center = blast.xy + ( forward * cos( angle ) + side * sin( angle ) ) * radius;
				float spin = hash( seed + 19.0 + float( k ) ) > 0.5 ? 1.0 : - 1.0;
				velocity += vortex( world, center, blast.z * 0.7, spin * swirl * 0.6 );

			}

		}

	}

	// ドラッグ
	for ( int i = 0; i < ${ MAX_DRAGS }; i ++ ) {

		vec4 drag = uDrags[ i ];
		if ( dot( drag.zw, drag.zw ) < 1e-6 ) continue;
		velocity += stir( world, drag.xy, drag.zw, uDragRadius );

	}

	// 範囲の端では流れを止める (霧が範囲の外から流れ込まないように)
	vec2 edge = min( vUv, 1.0 - vUv );
	velocity *= smoothstep( 0.0, 0.03, min( edge.x, edge.y ) );

	gl_FragColor = vec4( velocity, divergence, 1.0 );

}
`;

const curlShader = /* glsl */`
varying vec2 vUv;
uniform sampler2D uVelocity;
uniform vec2 uTexel;
uniform float uWorldSize;

void main() {

	float cell = uWorldSize * uTexel.x;
	float l = texture2D( uVelocity, vUv - vec2( uTexel.x, 0.0 ) ).y;
	float r = texture2D( uVelocity, vUv + vec2( uTexel.x, 0.0 ) ).y;
	float b = texture2D( uVelocity, vUv - vec2( 0.0, uTexel.y ) ).x;
	float t = texture2D( uVelocity, vUv + vec2( 0.0, uTexel.y ) ).x;
	gl_FragColor = vec4( ( ( r - l ) - ( t - b ) ) / ( 2.0 * cell ), 0.0, 0.0, 1.0 );

}
`;

// 霧フィールドの移流 (FogSimulation と同じ。湧き出し量は速度場の z から読む)
const advectFogShader = /* glsl */`
varying vec2 vUv;
uniform sampler2D uVelocity;
uniform sampler2D uFog;
uniform float uWorldSize;
uniform float uDt;
uniform float uDensityRecovery;
uniform float uOffsetRecovery;
uniform float uMaxDensity;
uniform float uStirDecay;

void main() {

	vec3 flow = texture2D( uVelocity, vUv ).xyz;
	vec2 velocity = flow.xy;
	vec4 fog = texture2D( uFog, vUv - velocity * uDt / uWorldSize );

	vec2 offset = ( fog.xy - velocity * uDt ) * exp( - uOffsetRecovery * uDt );

	float density = min( fog.z * exp( - flow.z * uDt ), uMaxDensity );
	density = mix( 1.0, density, exp( - uDensityRecovery * uDt ) );

	float stir = fog.w * exp( - uStirDecay * uDt );
	stir = min( stir + smoothstep( 2.5, 6.0, length( velocity ) ) * 8.0 * uDt, 1.0 );

	gl_FragColor = vec4( offset, density, stir );

}
`;

const fillShader = /* glsl */`
uniform vec4 uValue;

void main() {

	gl_FragColor = uValue;

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

export class FlowField {

	// resolution: 霧の解像度。速度場は滑らかなので velocityResolution (既定はその半分) で作る
	constructor( renderer, { resolution = 512, velocityResolution = resolution / 2, worldSize = 96 } = {} ) {

		this.renderer = renderer;
		this.resolution = resolution;
		this.worldSize = worldSize;
		this.updateRate = 60;

		this.params = {
			ambient: 0.8,
			densityRecovery: 0.12,
			offsetRecovery: 0.08,
			stirDecay: 1,
			blastStrength: 18,
			blastRadius: 1.1,
			blastDuration: 0.5,
			ringStart: 2,
			reach: 1.2,
			blastWidth: 1,
			blastSwirl: 4,
			swirlDuration: 1.5,
			refillStrength: 0.25,
			refillDelay: 1,
			ringWidth: 0.8,
			maxDensity: 2.5,
			dragRadius: 1.5,
			dragDuration: 0.5,
		};

		this.velocity = createTarget( velocityResolution );
		this.curl = createTarget( velocityResolution );
		this.fog = { read: createTarget( resolution ), write: createTarget( resolution ) };

		this._time = 0;
		this._accumulator = 0;
		this._blasts = [];
		this._drags = [];
		this._blastUniforms = [];
		this._blastShapes = [];
		this._blastSwirls = new Float32Array( MAX_BLASTS );
		this._dragUniforms = [];

		for ( let i = 0; i < MAX_BLASTS; i ++ ) {

			this._blastUniforms.push( new Vector4() );
			this._blastShapes.push( new Vector4() );

		}

		for ( let i = 0; i < MAX_DRAGS; i ++ ) {

			this._dragUniforms.push( new Vector4() );

		}

		const create = ( fragmentShader, uniforms ) => new ShaderMaterial( {
			vertexShader,
			fragmentShader,
			uniforms,
			depthTest: false,
			depthWrite: false,
		} );

		this._flow = create( flowShader, {
			uWorldSize: { value: worldSize },
			uTime: { value: 0 },
			uAmbient: { value: 0 },
			uBlasts: { value: this._blastUniforms },
			uBlastShapes: { value: this._blastShapes },
			uBlastSwirls: { value: this._blastSwirls },
			uBlastWidth: { value: 1 },
			uRingWidth: { value: 1 },
			uDrags: { value: this._dragUniforms },
			uDragRadius: { value: 1 },
		} );
		this._curl = create( curlShader, {
			uVelocity: { value: this.velocity.texture },
			uTexel: { value: new Vector2( 1 / velocityResolution, 1 / velocityResolution ) },
			uWorldSize: { value: worldSize },
		} );
		this._advectFog = create( advectFogShader, {
			uVelocity: { value: this.velocity.texture },
			uFog: { value: null },
			uWorldSize: { value: worldSize },
			uDt: { value: 0 },
			uDensityRecovery: { value: 0 },
			uOffsetRecovery: { value: 0 },
			uMaxDensity: { value: 1 },
			uStirDecay: { value: 1 },
		} );
		this._fill = create( fillShader, {
			uValue: { value: new Vector4() },
		} );
		this._quad = new FullScreenQuad();

		this.reset();

	}

	get velocityTexture() {

		return this.velocity.texture;

	}

	get fogTexture() {

		return this.fog.read.texture;

	}

	get curlTexture() {

		return this.curl.texture;

	}

	reset() {

		const fill = ( target, x, y, z, w ) => {

			this._fill.uniforms.uValue.value.set( x, y, z, w );
			this._render( this._fill, target );

		};

		fill( this.velocity, 0, 0, 0, 0 );
		fill( this.curl, 0, 0, 0, 0 );
		fill( this.fog.read, 0, 0, 1, 0 );
		fill( this.fog.write, 0, 0, 1, 0 );

		this._blasts = [];
		this._drags = [];

	}

	blast( x, z, dirX, dirZ ) {

		const length = Math.hypot( dirX, dirZ ) || 1;
		this._blasts.push( { x, z, dirX: dirX / length, dirZ: dirZ / length, seed: Math.random() * 100, age: 0 } );

		if ( this._blasts.length > MAX_BLASTS ) this._blasts.shift();

	}

	drag( x, z, vx, vz ) {

		this._drags.push( { x, z, vx, vz, age: 0 } );

		if ( this._drags.length > MAX_DRAGS ) this._drags.shift();

	}

	update( dt ) {

		const step = 1 / this.updateRate;
		this._accumulator = Math.min( this._accumulator + dt, step * 2 );

		while ( this._accumulator >= step ) {

			this._accumulator -= step;
			this._step( step );

		}

	}

	_step( dt ) {

		const params = this.params;
		this._time += dt;

		// 衝撃: 湧き出しは blastDuration、くるくるは swirlDuration で減衰させる
		for ( let i = 0; i < MAX_BLASTS; i ++ ) {

			const blast = this._blasts[ i ];

			if ( blast === undefined ) {

				this._blastUniforms[ i ].set( 0, 0, 1, 0 );
				this._blastSwirls[ i ] = 0;
				continue;

			}

			const decay = Math.exp( - blast.age / params.blastDuration );
			this._blastUniforms[ i ].set( blast.x, blast.z, params.blastRadius, params.blastStrength * decay );

			// 弧は減速しながら前へ進み、reach だけ進んだところで止まる
			const arcRadius = params.blastRadius * params.ringStart + params.reach * ( 1 - decay );
			this._blastShapes[ i ].set( blast.dirX, blast.dirZ, arcRadius, blast.seed );

			// 勢いが収まった後、弱い戻りの流れで弧に溜まった霧を中心へ戻す (age = refillDelay 付近が最大)
			const refillTime = blast.age / params.refillDelay;
			const refill = params.refillStrength * refillTime * Math.exp( 1 - refillTime );
			this._blastUniforms[ i ].w = params.blastStrength * ( decay - refill );

			// くるくるは衝撃の立ち上がりと一緒に強まり、ゆっくり消える
			const rise = 1 - Math.exp( - blast.age / 0.12 );
			this._blastSwirls[ i ] = params.blastSwirl * rise * Math.exp( - blast.age / params.swirlDuration );

			blast.age += dt;

		}

		const lifetime = Math.max( params.blastDuration, params.swirlDuration, params.refillDelay ) * 5;
		this._blasts = this._blasts.filter( ( blast ) => blast.age < lifetime );

		// ドラッグ
		for ( let i = 0; i < MAX_DRAGS; i ++ ) {

			const drag = this._drags[ i ];

			if ( drag === undefined ) {

				this._dragUniforms[ i ].set( 0, 0, 0, 0 );
				continue;

			}

			const decay = Math.exp( - drag.age / params.dragDuration );
			this._dragUniforms[ i ].set( drag.x, drag.z, drag.vx * decay, drag.vz * decay );
			drag.age += dt;

		}

		this._drags = this._drags.filter( ( drag ) => drag.age < params.dragDuration * 5 );

		// 1. 速度場
		const flow = this._flow.uniforms;
		flow.uTime.value = this._time;
		flow.uAmbient.value = params.ambient;
		flow.uBlastWidth.value = params.blastWidth;
		flow.uRingWidth.value = params.ringWidth;
		flow.uDragRadius.value = params.dragRadius;
		this._render( this._flow, this.velocity );

		// 2. 渦度 (霧の模様に使う)
		this._render( this._curl, this.curl );

		// 3. 霧の移流
		const advect = this._advectFog.uniforms;
		advect.uFog.value = this.fog.read.texture;
		advect.uDt.value = dt;
		advect.uDensityRecovery.value = params.densityRecovery;
		advect.uOffsetRecovery.value = params.offsetRecovery;
		advect.uMaxDensity.value = params.maxDensity;
		advect.uStirDecay.value = params.stirDecay;
		this._render( this._advectFog, this.fog.write );

		const temp = this.fog.read;
		this.fog.read = this.fog.write;
		this.fog.write = temp;

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
		this.curl.dispose();
		this.fog.read.dispose();
		this.fog.write.dispose();
		this._quad.dispose();

	}

}
