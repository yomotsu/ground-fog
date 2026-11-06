import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';
import { loadJXLTexture } from './loadJXLTexture.js';
import { GROUND_SIZE, getHeight, raycastTerrain } from './terrain.js';
import { FogSimulation } from './FogSimulation.js';
import { FlowField } from './FlowField.js';
import { VolumetricFog } from './VolumetricFog.js';

// カラーは 1024、それ以外は 512。distance 2 (非可逆)・effort 10 で圧縮したもの
const diffUrl = new URL( '../../textures/mud_forest_diff_1k_d2.jxl', import.meta.url ).href;
const norUrl = new URL( '../../textures/mud_forest_nor_gl_512_d2.jxl', import.meta.url ).href;
const roughUrl = new URL( '../../textures/mud_forest_rough_512_d2.jxl', import.meta.url ).href;
const dispUrl = new URL( '../../textures/mud_forest_disp_512_d2.jxl', import.meta.url ).href;

const GROUND_SEGMENTS = 256;
// テクスチャ 1 枚が覆う距離 (m)
const TILE_SIZE = 4;
// 流体シミュレーション (= 霧) の範囲 (m)
const FOG_SIZE = 96;

const renderer = new THREE.WebGLRenderer( { antialias: true } );
renderer.setPixelRatio( Math.min( window.devicePixelRatio, 2 ) );
renderer.setSize( window.innerWidth, window.innerHeight );
renderer.toneMapping = THREE.AgXToneMapping;
document.body.appendChild( renderer.domElement );

const scene = new THREE.Scene();
scene.background = new THREE.Color( 0x6f6a84 );
scene.fog = new THREE.Fog( 0x6f6a84, 30, 70 );

const camera = new THREE.PerspectiveCamera( 45, window.innerWidth / window.innerHeight, 0.1, 500 );
camera.position.set( 0, getHeight( 0, 0 ) + 9, 17.5 );

const orbit = new OrbitControls( camera, renderer.domElement );
orbit.target.set( 0, getHeight( 0, 0 ), 0 );
orbit.enableDamping = true;
orbit.maxPolarAngle = Math.PI * 0.45;
orbit.maxDistance = 40;
orbit.update();

// light

const hemiLight = new THREE.HemisphereLight( 0xb8b4d6, 0x3a3128, 1.2 );
scene.add( hemiLight );

const sunLight = new THREE.DirectionalLight( 0xffe2c0, 2.2 );
sunLight.position.set( - 30, 18, - 20 );
scene.add( sunLight );

// ground

function createGroundGeometry() {

	const geometry = new THREE.PlaneGeometry( GROUND_SIZE, GROUND_SIZE, GROUND_SEGMENTS, GROUND_SEGMENTS );
	geometry.rotateX( - Math.PI / 2 );

	const position = geometry.attributes.position;

	for ( let i = 0; i < position.count; i ++ ) {

		position.setY( i, getHeight( position.getX( i ), position.getZ( i ) ) );

	}

	geometry.computeVertexNormals();
	return geometry;

}

// テクスチャの読み込みが終わるまでは泥の平均的な色で表示する
const groundMaterial = new THREE.MeshStandardMaterial( {
	color: 0x2e2219,
	roughness: 1,
	metalness: 0,
	displacementScale: 0.12,
	displacementBias: - 0.06,
} );

const ground = new THREE.Mesh( createGroundGeometry(), groundMaterial );
scene.add( ground );

// 霧との交差を観察するための円柱 (中央に固定)

const PILLAR_RADIUS = 0.5;
const PILLAR_HEIGHT = 4;

const pillar = new THREE.Mesh(
	new THREE.CylinderGeometry( PILLAR_RADIUS, PILLAR_RADIUS, PILLAR_HEIGHT, 48 ),
	new THREE.MeshStandardMaterial( { color: 0x8c8478, roughness: 0.8 } ),
);
// 斜面でも浮かないよう、根元を周囲の一番低い地面より少し下まで埋める
let pillarBase = Infinity;

for ( let i = 0; i < 16; i ++ ) {

	const angle = i / 16 * Math.PI * 2;
	pillarBase = Math.min( pillarBase, getHeight( Math.cos( angle ) * PILLAR_RADIUS, Math.sin( angle ) * PILLAR_RADIUS ) );

}

pillar.position.set( 0, pillarBase - 0.2 + PILLAR_HEIGHT / 2, 0 );
scene.add( pillar );

async function loadGroundTextures() {

	const [ map, normalMap, roughnessMap, displacementMap ] = await Promise.all( [
		loadJXLTexture( diffUrl, { srgb: true } ),
		loadJXLTexture( norUrl ),
		loadJXLTexture( roughUrl ),
		loadJXLTexture( dispUrl, { channels: 1 } ),
	] );

	const repeat = GROUND_SIZE / TILE_SIZE;

	for ( const texture of [ map, normalMap, roughnessMap, displacementMap ] ) {

		texture.repeat.set( repeat, repeat );
		texture.anisotropy = renderer.capabilities.getMaxAnisotropy();

	}

	groundMaterial.color.set( 0xffffff );
	groundMaterial.map = map;
	groundMaterial.normalMap = normalMap;
	groundMaterial.roughnessMap = roughnessMap;
	groundMaterial.displacementMap = displacementMap;
	groundMaterial.needsUpdate = true;

}

loadGroundTextures().catch( ( error ) => console.error( error ) );

// fog

// 霧を動かす流れ。GUI の solver で切り替える
// stable fluids: 流体方程式を解く (1 ステップ 27 パス)
// procedural: 速度場を式で組み立てる軽量版 (1 ステップ 3 パス)
const solvers = {
	'stable fluids': new FogSimulation( renderer, { resolution: 512, worldSize: FOG_SIZE } ),
	procedural: new FlowField( renderer, { resolution: 512, worldSize: FOG_SIZE } ),
};
let simulation = solvers.procedural;
const volumetricFog = new VolumetricFog( renderer, simulation, { resolutionScale: 0.5 } );
volumetricFog.setSize( window.innerWidth, window.innerHeight );

// 霧を出す水平の範囲 (中心と大きさ、m)
const fogBounds = { centerX: 0, centerZ: 0, sizeX: FOG_SIZE, sizeZ: FOG_SIZE };

function applyFogBounds() {

	volumetricFog.bounds.min.set( fogBounds.centerX - fogBounds.sizeX / 2, fogBounds.centerZ - fogBounds.sizeZ / 2 );
	volumetricFog.bounds.max.set( fogBounds.centerX + fogBounds.sizeX / 2, fogBounds.centerZ + fogBounds.sizeZ / 2 );
	volumetricFog.updateBounds();

}

applyFogBounds();

// 範囲の表示
const boundsHelper = new THREE.Box3Helper( volumetricFog.boundsBox, 0xffcc44 );
boundsHelper.visible = false;
scene.add( boundsHelper );

// interaction
// クリック: その地点から前方 (カメラの奥方向) へ霧を吹き飛ばす
// Shift + ドラッグ: ドラッグ方向に霧を流す

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const hitPoint = new THREE.Vector3();
const previousHitPoint = new THREE.Vector3();
const pointerDown = new THREE.Vector2();
let hasPreviousHit = false;
let previousHitTime = 0;
let isStirring = false;

function pickTerrain( event, target ) {

	pointer.set( ( event.clientX / window.innerWidth ) * 2 - 1, - ( event.clientY / window.innerHeight ) * 2 + 1 );
	raycaster.setFromCamera( pointer, camera );
	return raycastTerrain( raycaster.ray, target );

}

renderer.domElement.addEventListener( 'pointerdown', ( event ) => {

	pointerDown.set( event.clientX, event.clientY );
	isStirring = event.shiftKey && event.button === 0;
	orbit.enabled = ! isStirring;
	hasPreviousHit = false;

} );

renderer.domElement.addEventListener( 'pointermove', ( event ) => {

	if ( ! isStirring ) return;

	if ( pickTerrain( event, hitPoint ) === null ) return;

	const now = performance.now() / 1000;

	if ( hasPreviousHit ) {

		const dt = Math.max( now - previousHitTime, 1 / 120 );
		// ドラッグの速さに対する霧の流れの強さ
		const scale = 0.1;
		const vx = THREE.MathUtils.clamp( ( hitPoint.x - previousHitPoint.x ) / dt * scale, - 4, 4 );
		const vz = THREE.MathUtils.clamp( ( hitPoint.z - previousHitPoint.z ) / dt * scale, - 4, 4 );
		simulation.drag( hitPoint.x, hitPoint.z, vx, vz );

	}

	previousHitPoint.copy( hitPoint );
	previousHitTime = now;
	hasPreviousHit = true;

} );

renderer.domElement.addEventListener( 'pointerup', ( event ) => {

	const wasStirring = isStirring;
	isStirring = false;
	orbit.enabled = true;

	if ( wasStirring || event.button !== 0 ) return;

	// ドラッグ (カメラ操作) と区別する
	if ( pointerDown.distanceTo( new THREE.Vector2( event.clientX, event.clientY ) ) > 5 ) return;

	if ( pickTerrain( event, hitPoint ) !== null ) {

		// カメラから見て奥 (クリック地点へ向かう水平方向) を前とする
		simulation.blast( hitPoint.x, hitPoint.z, hitPoint.x - camera.position.x, hitPoint.z - camera.position.z );

	}

} );

// gui

const gui = new GUI();
const columnUniforms = volumetricFog.columnMaterial.uniforms;
const marchUniforms = volumetricFog.marchMaterial.uniforms;
const fogFolder = gui.addFolder( 'fog' );
fogFolder.add( columnUniforms.uThickness, 'value', 0.2, 4 ).name( 'thickness' );
fogFolder.add( marchUniforms.uOpacity, 'value', 0.1, 6 ).name( 'density' );
fogFolder.add( marchUniforms.uFalloff, 'value', 0, 4 ).name( 'falloff' );
fogFolder.add( marchUniforms.uNoise, 'value', 0, 1 ).name( 'noise' );
fogFolder.add( columnUniforms.uDistortion, 'value', 0, 0.6 ).name( 'distortion' );
fogFolder.add( columnUniforms.uLift, 'value', 0, 1 ).name( 'lift' );
fogFolder.add( columnUniforms.uSwirlDetail, 'value', 0, 1 ).name( 'swirl detail' );
fogFolder.add( columnUniforms.uResidual, 'value', 0, 1 ).name( 'hole residual' );
fogFolder.addColor( { color: volumetricFog.colorLow.getHex() }, 'color' ).name( 'color low' ).onChange( ( value ) => volumetricFog.colorLow.setHex( value ) );
fogFolder.addColor( { color: volumetricFog.colorHigh.getHex() }, 'color' ).name( 'color high' ).onChange( ( value ) => volumetricFog.colorHigh.setHex( value ) );

const boundsFolder = gui.addFolder( 'bounds' );
boundsFolder.add( fogBounds, 'centerX', - FOG_SIZE / 2, FOG_SIZE / 2, 0.5 ).name( 'center x' ).onChange( applyFogBounds );
boundsFolder.add( fogBounds, 'centerZ', - FOG_SIZE / 2, FOG_SIZE / 2, 0.5 ).name( 'center z' ).onChange( applyFogBounds );
boundsFolder.add( fogBounds, 'sizeX', 1, FOG_SIZE, 0.5 ).name( 'size x' ).onChange( applyFogBounds );
boundsFolder.add( fogBounds, 'sizeZ', 1, FOG_SIZE, 0.5 ).name( 'size z' ).onChange( applyFogBounds );
boundsFolder.add( marchUniforms.uBoundsFade, 'value', 0.01, 10 ).name( 'edge fade' );
boundsFolder.add( boundsHelper, 'visible' ).name( 'show bounds' );
boundsFolder.close();

const qualityFolder = gui.addFolder( 'quality' );
qualityFolder.add( volumetricFog, 'steps', 8, 64, 1 );
qualityFolder.add( volumetricFog, 'resolutionScale', 0.25, 1, 0.05 ).name( 'resolution' ).onFinishChange( ( value ) => volumetricFog.setResolutionScale( value ) );
qualityFolder.add( marchUniforms.uJitterScale, 'value', 0, 1, 0.05 ).name( 'march jitter' );
qualityFolder.add( volumetricFog.upsampleBlur, 'value', 0, 1, 0.05 ).name( 'filter softness' );
qualityFolder.close();

const solverFolder = gui.addFolder( 'fluid' );
const solverSettings = { solver: 'procedural', updateRate: 30 };

// 各 solver のパラメータ
const solverFolders = {};

function addParams( folder, params, ranges ) {

	for ( const [ key, range ] of Object.entries( ranges ) ) {

		if ( key in params ) folder.add( params, key, ...range );

	}

}

const sharedRanges = {
	blastStrength: [ 0, 40 ],
	blastRadius: [ 0.3, 5 ],
	blastDuration: [ 0.05, 1 ],
	ringStart: [ 1, 4 ],
	reach: [ 0, 10 ],
	blastWidth: [ 0.1, 1.5 ],
	blastSwirl: [ 0, 5 ],
	ringWidth: [ 0.2, 2 ],
	maxDensity: [ 1, 5 ],
	ambient: [ 0, 3 ],
	densityRecovery: [ 0, 1 ],
	offsetRecovery: [ 0, 1 ],
	stirDecay: [ 0.05, 3 ],
	dragRadius: [ 0.3, 5 ],
};

solverFolders[ 'stable fluids' ] = solverFolder.addFolder( 'stable fluids' );
addParams( solverFolders[ 'stable fluids' ], solvers[ 'stable fluids' ].params, {
	...sharedRanges,
	blastPush: [ 0, 5 ],
	vorticity: [ 0, 30 ],
	velocityDissipation: [ 0, 3 ],
	pressureIterations: [ 1, 80, 1 ],
} );

solverFolders.procedural = solverFolder.addFolder( 'procedural' );
addParams( solverFolders.procedural, solvers.procedural.params, {
	...sharedRanges,
	swirlDuration: [ 0.1, 4 ],
	refillStrength: [ 0, 1 ],
	refillDelay: [ 0.2, 3 ],
	dragDuration: [ 0.05, 2 ],
} );

function applySolver() {

	simulation = solvers[ solverSettings.solver ];
	simulation.updateRate = solverSettings.updateRate;
	simulation.reset();
	volumetricFog.simulation = simulation;

	for ( const [ name, folder ] of Object.entries( solverFolders ) ) {

		folder.show( name === solverSettings.solver );
		folder.close();

	}

}

solverFolder.add( solverSettings, 'solver', Object.keys( solvers ) ).onChange( applySolver );
solverFolder.add( solverSettings, 'updateRate', [ 60, 30, 20 ] ).name( 'update rate' ).onChange( ( value ) => {

	simulation.updateRate = value;

} );
solverFolder.add( { reset: () => simulation.reset() }, 'reset' );
applySolver();
solverFolder.close();
gui.close();

// loop

window.addEventListener( 'resize', () => {

	camera.aspect = window.innerWidth / window.innerHeight;
	camera.updateProjectionMatrix();
	renderer.setSize( window.innerWidth, window.innerHeight );
	volumetricFog.setSize( window.innerWidth, window.innerHeight );

} );

const timer = new THREE.Timer();
timer.connect( document );

renderer.setAnimationLoop( ( timestamp ) => {

	timer.update( timestamp );
	const dt = Math.min( timer.getDelta(), 1 / 30 );

	orbit.update();
	simulation.update( dt );
	volumetricFog.render( scene, camera, timer.getElapsed() );

} );
