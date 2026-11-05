import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';
import { loadJXLTexture } from './loadJXLTexture.js';
import { GROUND_SIZE, getHeight, raycastTerrain } from './terrain.js';
import { FogSimulation } from './FogSimulation.js';
import { FogLayers } from './FogLayers.js';

// カラーは 1024、それ以外は 512。distance 2 (非可逆)・effort 10 で圧縮したもの
const diffUrl = new URL( '../textures/mud_forest_diff_1k_d2.jxl', import.meta.url ).href;
const norUrl = new URL( '../textures/mud_forest_nor_gl_512_d2.jxl', import.meta.url ).href;
const roughUrl = new URL( '../textures/mud_forest_rough_512_d2.jxl', import.meta.url ).href;
const dispUrl = new URL( '../textures/mud_forest_disp_512_d2.jxl', import.meta.url ).href;

const GROUND_SEGMENTS = 512;
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

const simulation = new FogSimulation( renderer, { resolution: 512, worldSize: FOG_SIZE } );
const fogLayers = new FogLayers( simulation, { layerCount: 4, segments: 192 } );
scene.add( fogLayers );

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
const fogUniforms = fogLayers.material.uniforms;
const heightUniforms = fogLayers.heightMaterial.uniforms;
const fogFolder = gui.addFolder( 'fog' );
fogFolder.add( fogLayers, 'showMesh' ).name( 'show mesh' );
fogFolder.add( fogLayers, 'layerCount', 1, 6, 1 ).name( 'layers' );
fogFolder.add( fogUniforms.uLayerSpacing, 'value', 0.2, 1 ).name( 'layer spacing' );
fogFolder.add( fogUniforms.uLayerFalloff, 'value', 0, 4 ).name( 'layer falloff' );
fogFolder.add( fogUniforms.uLayerJitter, 'value', 0, 1 ).name( 'layer jitter' );
fogFolder.add( fogUniforms.uSwirlDetail, 'value', 0, 1 ).name( 'swirl detail' );
fogFolder.add( fogUniforms.uResidual, 'value', 0, 1 ).name( 'hole residual' );
fogFolder.add( heightUniforms.uThickness, 'value', 0.2, 4 ).name( 'thickness' );
fogFolder.add( fogUniforms.uOpacity, 'value', 0.1, 6 ).name( 'density' );
fogFolder.add( heightUniforms.uDistortion, 'value', 0, 0.6 ).name( 'distortion' );
fogFolder.add( heightUniforms.uLift, 'value', 0, 1 ).name( 'lift' );
fogFolder.addColor( { color: fogUniforms.uColorLow.value.getHex() }, 'color' ).name( 'color low' ).onChange( ( value ) => fogUniforms.uColorLow.value.setHex( value ) );
fogFolder.addColor( { color: fogUniforms.uColorHigh.value.getHex() }, 'color' ).name( 'color high' ).onChange( ( value ) => fogUniforms.uColorHigh.value.setHex( value ) );

const fluidFolder = gui.addFolder( 'fluid' );
const params = simulation.params;
fluidFolder.add( params, 'blastStrength', 0, 40 );
fluidFolder.add( params, 'blastRadius', 0.3, 5 );
fluidFolder.add( params, 'blastDuration', 0.05, 1 );
fluidFolder.add( params, 'ringStart', 1, 4 );
fluidFolder.add( params, 'reach', 0, 10 );
fluidFolder.add( params, 'blastPush', 0, 5 );
fluidFolder.add( params, 'blastWidth', 0.1, 1.5 );
fluidFolder.add( params, 'blastSwirl', 0, 3 );
fluidFolder.add( params, 'ringWidth', 0.2, 2 );
fluidFolder.add( params, 'maxDensity', 1, 5 );
fluidFolder.add( params, 'vorticity', 0, 30 );
fluidFolder.add( params, 'ambient', 0, 3 );
fluidFolder.add( params, 'velocityDissipation', 0, 3 );
fluidFolder.add( params, 'densityRecovery', 0, 1 );
fluidFolder.add( params, 'offsetRecovery', 0, 1 );
fluidFolder.add( params, 'stirDecay', 0.05, 3 );
fluidFolder.add( params, 'pressureIterations', 1, 80, 1 );
fluidFolder.add( { reset: () => simulation.reset() }, 'reset' );
fluidFolder.close();
gui.close();

// loop

window.addEventListener( 'resize', () => {

	camera.aspect = window.innerWidth / window.innerHeight;
	camera.updateProjectionMatrix();
	renderer.setSize( window.innerWidth, window.innerHeight );

} );

const timer = new THREE.Timer();
timer.connect( document );

renderer.setAnimationLoop( ( timestamp ) => {

	timer.update( timestamp );
	const dt = Math.min( timer.getDelta(), 1 / 30 );

	orbit.update();
	simulation.update( dt );
	fogLayers.update( renderer, timer.getElapsed() );
	renderer.render( scene, camera );

} );
