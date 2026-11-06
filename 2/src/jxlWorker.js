// import map はワーカー内では効かないため、メインスレッドで解決済みの URL を
// init メッセージで受け取って動的 import する

let ready = null;
let DataUtils = null;
let JxlImage = null;
let decodePNG = null;

async function loadModules( modules ) {

	const [ three, jxl, png ] = await Promise.all( [
		import( modules.three ),
		import( modules.jxl ),
		import( modules.png ),
	] );

	// wasm は jxl-oxide-wasm 内の new URL( ..., import.meta.url ) で解決される
	await jxl.default();

	DataUtils = three.DataUtils;
	JxlImage = jxl.JxlImage;
	decodePNG = png.decode;

}

// JXL -> 16bit PNG (jxl-oxide) -> Uint16Array (fast-png)
// ブラウザ標準デコーダを通すと 8bit に落ちるため WASM で直接展開する
function decodeJXL( bytes ) {

	const image = new JxlImage();
	image.feedBytes( bytes );

	if ( ! image.tryInit() ) {

		image.free();
		throw new Error( 'JXL: incomplete data' );

	}

	const result = image.render();
	// encodeToPng は RenderResult を消費する (free 不要)
	const png = decodePNG( result.encodeToPng() );
	image.free();

	return {
		width: png.width,
		height: png.height,
		channels: png.channels,
		data: png.data,
	};

}

function srgbToLinear( c ) {

	return c <= 0.04045 ? c / 12.92 : Math.pow( ( c + 0.055 ) / 1.055, 2.4 );

}

// 16bit 整数 -> HalfFloat (RGBA または R)
// outChannels: 4 なら RGBA に展開、1 なら先頭チャンネルのみ
function toHalfFloat( image, outChannels, srgb ) {

	const { width, height, channels, data } = image;
	const count = width * height;
	const out = new Uint16Array( count * outChannels );
	const one = DataUtils.toHalfFloat( 1 );

	// sRGB デコードは 65536 段の LUT で済ませる
	let lut = null;

	if ( srgb ) {

		lut = new Uint16Array( 65536 );

		for ( let i = 0; i < 65536; i ++ ) {

			lut[ i ] = DataUtils.toHalfFloat( srgbToLinear( i / 65535 ) );

		}

	}

	const convert = ( v ) => lut !== null ? lut[ v ] : DataUtils.toHalfFloat( v / 65535 );

	for ( let i = 0; i < count; i ++ ) {

		const src = i * channels;
		const dst = i * outChannels;

		if ( outChannels === 1 ) {

			out[ dst ] = convert( data[ src ] );
			continue;

		}

		const gray = channels < 3;
		out[ dst ] = convert( data[ src ] );
		out[ dst + 1 ] = convert( data[ gray ? src : src + 1 ] );
		out[ dst + 2 ] = convert( data[ gray ? src : src + 2 ] );
		out[ dst + 3 ] = channels === 4 || channels === 2 ? convert( data[ src + channels - 1 ] ) : one;

	}

	return out;

}

self.onmessage = async ( event ) => {

	if ( event.data.type === 'init' ) {

		ready = loadModules( event.data.modules );
		return;

	}

	const { id, url, outChannels, srgb } = event.data;

	try {

		await ready;
		const bytes = new Uint8Array( await ( await fetch( url ) ).arrayBuffer() );
		const image = decodeJXL( bytes );
		const data = toHalfFloat( image, outChannels, srgb );
		self.postMessage( { id, width: image.width, height: image.height, data }, [ data.buffer ] );

	} catch ( error ) {

		self.postMessage( { id, error: String( error ) } );

	}

};
