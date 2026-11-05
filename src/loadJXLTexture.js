import {
	DataTexture,
	HalfFloatType,
	LinearMipmapLinearFilter,
	LinearFilter,
	NoColorSpace,
	RedFormat,
	RepeatWrapping,
	RGBAFormat,
} from 'three';

// ワーカーには import map が効かないので、ここで解決した URL を渡す
const WORKER_MODULES = {
	three: import.meta.resolve( 'three' ),
	jxl: import.meta.resolve( 'jxl-oxide-wasm' ),
	png: import.meta.resolve( 'fast-png' ),
};

const workers = [];
const pending = new Map();
let nextId = 0;
let nextWorker = 0;

function getWorker() {

	const size = Math.min( navigator.hardwareConcurrency || 2, 4 );

	if ( workers.length < size ) {

		const worker = new Worker( new URL( './jxlWorker.js', import.meta.url ), { type: 'module' } );
		worker.onmessage = onMessage;
		worker.postMessage( { type: 'init', modules: WORKER_MODULES } );
		workers.push( worker );
		return worker;

	}

	return workers[ nextWorker ++ % workers.length ];

}

function onMessage( event ) {

	const { id, error } = event.data;
	const { resolve, reject } = pending.get( id );
	pending.delete( id );

	if ( error !== undefined ) {

		reject( new Error( error ) );

	} else {

		resolve( event.data );

	}

}

// 16bit lossless JXL を HalfFloat の DataTexture として読み込む
// srgb: true ならワーカー側でリニア化する (HalfFloat は GPU の sRGB デコードが効かないため)
export function loadJXLTexture( url, { channels = 4, srgb = false } = {} ) {

	const id = nextId ++;

	return new Promise( ( resolve, reject ) => {

		pending.set( id, { resolve, reject } );
		getWorker().postMessage( { id, url, outChannels: channels, srgb } );

	} ).then( ( { width, height, data } ) => {

		const texture = new DataTexture( data, width, height, channels === 1 ? RedFormat : RGBAFormat, HalfFloatType );
		texture.wrapS = RepeatWrapping;
		texture.wrapT = RepeatWrapping;
		texture.magFilter = LinearFilter;
		texture.minFilter = LinearMipmapLinearFilter;
		texture.generateMipmaps = true;
		texture.anisotropy = 8;
		// PNG/JXL は上から下、テクスチャ座標は下から上
		texture.flipY = true;
		texture.colorSpace = NoColorSpace;
		texture.needsUpdate = true;
		return texture;

	} );

}
