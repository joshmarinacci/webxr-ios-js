import * as mat4 from 'gl-matrix/src/gl-matrix/mat4'

import PolyfilledXRDevice from 'webxr-polyfill/src/devices/PolyfilledXRDevice'

import {throttle, throttledConsoleLog} from '../lib/throttle.js'

import ARKitWrapper from './ARKitWrapper.js'
import ARKitWatcher from './ARKitWatcher.js'
import XRGeospatialAnchor from '../extensions/XRGeospatialAnchor.js';

var styleEl = document.createElement('style');
// Append <style> element to <head>
document.head.appendChild(styleEl);
// Grab style element's sheet
var styleSheet = styleEl.sheet;
styleSheet.insertRule('.arkit-device-wrapper { z-index: -1; }', 0);
styleSheet.insertRule('.arkit-device-wrapper, .xr-canvas { position: absolute; top: 0; left: 0; bottom: 0; right: 0; }', 0);
styleSheet.insertRule('.arkit-device-wrapper, .arkit-device-wrapper canvas { width: 100%; height: 100%; padding: 0; margin: 0; -webkit-user-select: none; user-select: none; }', 0);

export default class ARKitDevice extends PolyfilledXRDevice {
	constructor(global){
		super(global)
		this._throttledLogPose = throttle(this.logPose, 1000)

		this._sessions = new Map()
		this._activeSession = null

		// A div prepended to body children that will contain the session layer
		this._wrapperDiv = document.createElement('div')
		this._wrapperDiv.setAttribute('class', 'arkit-device-wrapper')
		document.addEventListener('DOMContentLoaded', ev => {
			document.body.insertBefore(this._wrapperDiv, document.body.firstChild || null)
		})

		this._headModelMatrix = mat4.create() // Model and view matrix are the same
		this._projectionMatrix = mat4.create()
		this._eyeLevelMatrix = mat4.identity(mat4.create())
		this._stageMatrix = mat4.identity(mat4.create())
		this._stageMatrix[13] = -1.3

		this._depthNear = 0.1
		this._depthFar = 1000

		try{
			this._arKitWrapper = ARKitWrapper.GetOrCreate()
			this._arWatcher = new ARWatcher(this._arKitWrapper, this)
		} catch (e){
			console.error('Error initializing the ARKit wrapper', e)
			this._arKitWrapper = null
			this._arWatcher = null
		}
	}

	get depthNear(){ return this._depthNear }
	set depthNear(val){ this._depthNear = val }

	get depthFar(){ return this._depthFar }
	set depthFar(val){ this._depthFar = val }

	supportsSession(options={}){
		// true if:
		//  not (geolocation and not alignEUS)  ==>  can only use geolocation if aligneus is true
		//  not immersive
		return  !(!options.alignEUS && options.geolocation) && !options.immersive
	}

	async requestSession(options={}){
		if(!this.supportsSession(options)){
			console.error('Invalid session options', options)
			return Promise.reject()
		}
		if(!this._arKitWrapper){
			console.error('Session requested without an ARKitWrapper')
			return Promise.reject()
		}
		if(this._activeSession !== null){
			console.error('Tried to start a second active session')
			return Promise.reject()
		}

		var ARKitOptions = {}
		if (options.worldSensing) {
			ARKitOptions.worldSensing = options.worldSensing
		}
		if (options.computerVision) {
			ARKitOptions.videoFrames = options.useComputerVision
		}
		if (options.alignEUS) {
			ARKitOptions.alignEUS = options.alignEUS
		}
		var geolocation = false
		if (options.geolocation && options.alignEUS) {
			geolocation = true
		}
		let initResult = await this._arKitWrapper.waitForInit().then(() => {
		}).catch((...params) => {
			console.error("app failed to initialize: ", ...params)
			return Promise.reject()
		})

		let watchResult = await this._arKitWrapper.watch(ARKitOptions).then((results) => {
			const session = new Session(options.outputContext || null)
			this._sessions.set(session.id, session)
			this._activeSession = session

			session._useGeolocation = geolocation
			if (geolocation) {
//				XRGeospatialAnchor.useSession(session)
			}

			return Promise.resolve(session.id)
		}).catch((...params) => {
			console.error("session request failed: ", ...params)
			return Promise.reject()
		})

		return watchResult
	}

	onBaseLayerSet(sessionId, layer){
		this._sessions.get(sessionId).baseLayer = layer // XRWebGLLayer
		this._wrapperDiv.appendChild(layer.context.canvas)

		layer.context.canvas.style.width = "100%";
		layer.context.canvas.style.height = "100%";
		layer.width = layer.context.canvas.width = this._wrapperDiv.clientWidth * window.devicePixelRatio;
		layer.height = layer.context.canvas.height = this._wrapperDiv.clientHeight * window.devicePixelRatio;
	}

	requestAnimationFrame(callback, ...params){
//		return window.requestAnimationFrame((...params) => {
		// 	this._arKitWrapper.startingRender()
		// 	try {
		// 		callback(...params)
		// 	} catch(e) {
		// 		console.error('application callback error: ', e)
		// 	}	
		// 	this._arKitWrapper.finishedRender()
		// })
	    this._arKitWrapper.requestAnimationFrame(callback, params)
		}

	cancelAnimationFrame(handle){
		return window.cancelAnimationFrame(handle)
	}

	onFrameStart(sessionId){
		// TODO
		//this._throttledLogPose()
	}

	onFrameEnd(sessionId){
		// TODO
	}

	logPose(){
		console.log('pose', 
			mat4.getTranslation(new Float32Array(3), this._headModelMatrix),
			mat4.getRotation(new Float32Array(4), this._headModelMatrix)
		)
	}

	async requestFrameOfReferenceTransform(type, options){
		switch(type){
			case 'head-model':
				return this._headModelMatrix
			case 'eye-level':
				return this._eyeLevelMatrix
			case 'stage':
				//return this._stageMatrix
				throw new Error('stage not supported', type)
			default:
				throw new Error('Unsupported frame of reference type', type)
		}
	}

	endSession(sessionId){
		const session = this._sessions.get(sessionId);
		if(!session || session.ended) return
		session.ended = true
		if(this._activeSession === session){
			this._activeSession = null
			this._arKitWrapper.stop()
		}
		if(session.baseLayer !== null){
			this._wrapperDiv.removeChild(session.baseLayer.context.canvas)
		}
		if (session._useGeolocation) {
			XRGeospatialAnchor.closeSession()
		}
	}

	getViewport(sessionId, eye, layer, target){
		// A single viewport that covers the entire screen
		const { width, height } = layer.context.canvas
		target.x = 0
		target.y = 0
		target.width = width
		target.height = height
		return true
	}

	getProjectionMatrix(eye){
		return this._projectionMatrix
	}

	setProjectionMatrix(matrix){
		mat4.copy(this._projectionMatrix, matrix)
	}

	// The model and view matrices are the same head-model matrix
	getBasePoseMatrix(){
		return this._headModelMatrix
	}
	getBaseViewMatrix(eye){
		return this._headModelMatrix
	}

	setBaseViewMatrix(matrix){
		mat4.copy(this._headModelMatrix, matrix)
	}

	requestStageBounds(){
		return null
	}

	getInputSources(){
		return []
	}

	getInputPose(inputSource, coordinateSystem){
		return null
	}

	onWindowResize(){
		this._sessions.forEach((value, key) => {
			var layer = value.baseLayer

			layer.width = layer.context.canvas.width = this._wrapperDiv.clientWidth;
			layer.height = layer.context.canvas.height = this._wrapperDiv.clientHeight;
		})
	}
}

let SESSION_ID = 100
class Session {
	constructor(outputContext){
		this.ended = null // boolean
		this.outputContext = outputContext // XRPresentationContext
		this.baseLayer = null // XRWebGLLayer
		this.id = ++SESSION_ID
	}
}

class ARWatcher extends ARKitWatcher {
	constructor(arKitWrapper, arKitDevice){
		super(arKitWrapper)
		this._arKitDevice = arKitDevice
	}
	handleARKitUpdate(event){
		// const cameraTransformMatrix = this._arKitWrapper._getData('camera_transform')
		// if (cameraTransformMatrix) {
		// 	this._arKitDevice.setBaseViewMatrix(cameraTransformMatrix)
		// } else {
		// 	console.log('no camera transform', this._arKitWrapper.rawARData)
		// }
		this._arKitDevice.setBaseViewMatrix(this._arKitWrapper._cameraTransform)

		// const cameraProjectionMatrix = this._arKitWrapper._getData('projection_camera')
		// if(cameraProjectionMatrix){
		// 	this._arKitDevice.setProjectionMatrix(cameraProjectionMatrix)
		// } else {
		// 	console.log('no projection camera', this._arKitWrapper.rawARData)
		// }
		this._arKitDevice.setProjectionMatrix(this._arKitWrapper._projectionMatrix)
	}
	handleOnError(...args){
		console.error('ARKit error', ...args)
	}
}

