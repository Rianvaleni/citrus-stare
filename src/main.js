import './style.css'
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'

const app = document.querySelector('#app')

app.innerHTML = `
  <div class="scene">
    <div class="backdrop"></div>
    <div class="stage">
      <div class="viewport">
        <video id="video" autoplay muted playsinline></video>
        <canvas id="overlay"></canvas>
      </div>
      <div class="hud" role="status" aria-live="polite">
        <div class="hud-row">
          <span class="hud-label">Status</span>
          <span id="status" class="hud-value" data-tone="loading">Booting…</span>
        </div>
        <div class="hud-row">
          <span class="hud-label">Faces</span>
          <span id="faces" class="hud-value">0</span>
        </div>
        <div class="hud-row">
          <span class="hud-label">FPS</span>
          <span id="fps" class="hud-value">--</span>
        </div>
      </div>
      <div id="message" class="message" aria-live="polite"></div>
    </div>
  </div>
`

const video = document.querySelector('#video')
const canvas = document.querySelector('#overlay')
const ctx = canvas.getContext('2d')
const statusEl = document.querySelector('#status')
const facesEl = document.querySelector('#faces')
const fpsEl = document.querySelector('#fps')
const messageEl = document.querySelector('#message')

let faceLandmarker
let lastVideoTime = -1
let lastFpsSample = performance.now()
let frames = 0

const modelAssetPath =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'
const wasmPath =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
const tessellationConnections =
  FaceLandmarker.FACE_LANDMARKS_TESSELATION ??
  FaceLandmarker.FACE_LANDMARKS_CONTOURS ??
  []

const statusTones = {
  loading: 'loading',
  ready: 'ready',
  warning: 'warning',
  error: 'error'
}

function setStatus(text, tone = statusTones.ready) {
  statusEl.textContent = text
  statusEl.dataset.tone = tone
}

function setMessage(text = '') {
  messageEl.textContent = text
  messageEl.dataset.visible = text ? 'true' : 'false'
}

function resizeCanvas() {
  const displayWidth = video.clientWidth
  const displayHeight = video.clientHeight
  if (!displayWidth || !displayHeight) return

  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.round(displayWidth * dpr)
  canvas.height = Math.round(displayHeight * dpr)
  canvas.style.width = `${displayWidth}px`
  canvas.style.height = `${displayHeight}px`
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
}

function getCoverTransform() {
  const displayWidth = canvas.clientWidth
  const displayHeight = canvas.clientHeight
  const videoWidth = video.videoWidth
  const videoHeight = video.videoHeight
  if (!displayWidth || !displayHeight || !videoWidth || !videoHeight) return null

  const scale = Math.max(displayWidth / videoWidth, displayHeight / videoHeight)
  const offsetX = (displayWidth - videoWidth * scale) / 2
  const offsetY = (displayHeight - videoHeight * scale) / 2

  return { scale, offsetX, offsetY, videoWidth, videoHeight }
}

function drawConnections(landmarks, connections = [], transform) {
  if (!connections || typeof connections[Symbol.iterator] !== 'function') return
  ctx.strokeStyle = 'rgba(80, 230, 208, 0.75)'
  ctx.lineWidth = 1.1
  for (const connection of connections) {
    const start =
      connection?.start ?? (Array.isArray(connection) ? connection[0] : null)
    const end =
      connection?.end ?? (Array.isArray(connection) ? connection[1] : null)
    if (start == null || end == null) continue
    const from = landmarks[start]
    const to = landmarks[end]
    if (!from || !to) continue
    const x1 = from.x * transform.videoWidth * transform.scale + transform.offsetX
    const y1 = from.y * transform.videoHeight * transform.scale + transform.offsetY
    const x2 = to.x * transform.videoWidth * transform.scale + transform.offsetX
    const y2 = to.y * transform.videoHeight * transform.scale + transform.offsetY
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2, y2)
    ctx.stroke()
  }
}

function drawLandmarks(landmarks, transform) {
  ctx.fillStyle = 'rgba(255, 255, 255, 0.7)'
  for (const point of landmarks) {
    const x = point.x * transform.videoWidth * transform.scale + transform.offsetX
    const y = point.y * transform.videoHeight * transform.scale + transform.offsetY
    ctx.beginPath()
    ctx.arc(x, y, 0.7, 0, Math.PI * 2)
    ctx.fill()
  }
}

function updateFps() {
  frames += 1
  const now = performance.now()
  const elapsed = now - lastFpsSample
  if (elapsed > 900) {
    const fps = Math.round((frames * 1000) / elapsed)
    fpsEl.textContent = `${fps}`
    frames = 0
    lastFpsSample = now
  }
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Camera API not supported in this browser.')
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: 'user',
      width: { ideal: 1280 },
      height: { ideal: 720 }
    }
  })

  video.srcObject = stream
  await new Promise((resolve) => {
    video.onloadedmetadata = () => resolve()
  })
  await video.play()
  resizeCanvas()
}

function describeCameraError(error) {
  if (!error) return 'Unable to access the camera.'
  if (error.name === 'NotAllowedError') {
    return 'Camera access was blocked. Please allow permission and refresh.'
  }
  if (error.name === 'NotFoundError') {
    return 'No camera was found on this device.'
  }
  if (error.name === 'NotReadableError') {
    return 'Your camera is already in use by another app.'
  }
  if (error.name === 'OverconstrainedError') {
    return 'The requested camera constraints are not supported.'
  }
  return null
}

function describeInitError(error) {
  const cameraMessage = describeCameraError(error)
  if (cameraMessage) return cameraMessage
  if (error?.message?.toLowerCase().includes('fetch')) {
    return 'Failed to load MediaPipe assets. Check your connection and refresh.'
  }
  return error?.message || 'Unable to start face tracking.'
}

async function setupFaceLandmarker() {
  setStatus('Loading model…', statusTones.loading)
  const resolver = await FilesetResolver.forVisionTasks(wasmPath)
  faceLandmarker = await FaceLandmarker.createFromOptions(resolver, {
    baseOptions: {
      modelAssetPath,
      delegate: 'GPU'
    },
    runningMode: 'VIDEO',
    numFaces: 1
  })
}

async function init() {
  try {
    setMessage('Allow camera access to begin.')
    await setupFaceLandmarker()
    setStatus('Requesting camera…', statusTones.loading)
    await startCamera()
    setMessage('')
    setStatus('Live', statusTones.ready)
    requestAnimationFrame(predict)
  } catch (error) {
    console.error(error)
    setStatus('Error', statusTones.error)
    setMessage(describeInitError(error))
  }
}

function predict() {
  if (!faceLandmarker || video.readyState < 2) {
    requestAnimationFrame(predict)
    return
  }

  const now = performance.now()
  if (video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime
    const results = faceLandmarker.detectForVideo(video, now)

    const dpr = window.devicePixelRatio || 1
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr)

    if (results.faceLandmarks?.length) {
      const transform = getCoverTransform()
      if (transform) {
        for (const landmarks of results.faceLandmarks) {
          drawConnections(landmarks, tessellationConnections, transform)
          drawLandmarks(landmarks, transform)
        }
      }
      facesEl.textContent = `${results.faceLandmarks.length}`
    } else {
      facesEl.textContent = '0'
    }
  }

  updateFps()
  requestAnimationFrame(predict)
}

window.addEventListener('resize', resizeCanvas)

init()
