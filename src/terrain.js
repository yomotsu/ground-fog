import { SimplexNoise } from 'three/addons/math/SimplexNoise.js';

export const GROUND_SIZE = 160;

const simplex = new SimplexNoise();

// 緩やかな起伏: 低周波の fBm
export function getHeight( x, z ) {

	let height = 0;
	let amplitude = 1.6;
	let frequency = 1 / 40;

	for ( let i = 0; i < 4; i ++ ) {

		height += simplex.noise( x * frequency, z * frequency ) * amplitude;
		amplitude *= 0.45;
		frequency *= 2.1;

	}

	return height;

}

// 地形の高さ関数に対してレイマーチ + 二分探索で交点を求める
export function raycastTerrain( ray, target, maxDistance = 300 ) {

	const step = 0.5;
	let previous = 0;

	for ( let t = step; t < maxDistance; t += step ) {

		ray.at( t, target );

		if ( target.y < getHeight( target.x, target.z ) ) {

			let near = previous;
			let far = t;

			for ( let i = 0; i < 12; i ++ ) {

				const mid = ( near + far ) * 0.5;
				ray.at( mid, target );

				if ( target.y < getHeight( target.x, target.z ) ) {

					far = mid;

				} else {

					near = mid;

				}

			}

			ray.at( far, target );
			return target;

		}

		previous = t;

	}

	return null;

}
