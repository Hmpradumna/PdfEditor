// script.js - Futuristic PDF & Image Studio (vanilla JS)
// Relies on: pdf-lib (PDFLib), pdf.js (pdfjsLib), browser-image-compression

// ---------- globals ----------
const fileInput = document.getElementById('fileInput')
const dropZone = document.getElementById('dropZone')
const pagesList = document.getElementById('pagesList')
const baseCanvas = document.getElementById('baseCanvas')
const overlayCanvas = document.getElementById('overlayCanvas')
const textLayer = document.getElementById('textLayer')
const qualityRange = document.getElementById('qualityRange')

const prevBtn = document.getElementById('prevBtn')
const nextBtn = document.getElementById('nextBtn')
const pageInfo = document.getElementById('pageInfo')
const downloadPdfBtn = document.getElementById('downloadPdfBtn')
const imgToPdfBtn = document.getElementById('imgToPdfBtn')
const pdfToImgBtn = document.getElementById('pdfToImgBtn')
const compressBtn = document.getElementById('compressBtn')
const downloadPageImg = document.getElementById('downloadPageImg')

const ctx = overlayCanvas.getContext('2d')
const baseCtx = baseCanvas.getContext('2d')

// pdf.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.6.172/pdf.worker.min.js'

// state
let documents = [] // {type:'pdf'|'image', file:File, pages:[{canvas,originalWidth,originalHeight}], pdfDoc (Uint8Array) }
let currentDocIndex = -1
let currentPageIndex = 0
let tool = 'pan' // pan, draw, text, redact
let drawing = false
let lastPos = null
let drawColor = '#fffb7a'
let drawWidth = 3
let redactRects = [] // {x,y,w,h,page}
let textBoxes = [] // {x,y,w,h,text,page,el}
let imageInputs = [] // store image File objects to convert to PDF
let selectedFile = null

// ---------- utilities ----------
function setTool(newTool){
  tool = newTool
  document.querySelectorAll('.tool').forEach(b => b.classList.toggle('active', b.dataset.tool === newTool))
  overlayCanvas.style.cursor = (newTool === 'draw' ? 'crosshair' : newTool === 'text' ? 'text' : 'default')
  if(newTool === 'pan') overlayCanvas.style.pointerEvents = 'none'
  else overlayCanvas.style.pointerEvents = 'auto'
}

function fitCanvasesTo(containerWidth, containerHeight, imgW, imgH){
  // scale to fit inside container while keeping ratio
  const maxW = containerWidth - 36 /* padding */;
  const maxH = containerHeight - 36;
  const ratio = Math.min(maxW / imgW, maxH / imgH, 1)
  const drawW = Math.round(imgW * ratio)
  const drawH = Math.round(imgH * ratio)
  baseCanvas.width = drawW
  baseCanvas.height = drawH
  overlayCanvas.width = drawW
  overlayCanvas.height = drawH
  overlayCanvas.style.left = baseCanvas.offsetLeft + 'px'
  overlayCanvas.style.top = baseCanvas.offsetTop + 'px'
  textLayer.style.width = drawW + 'px'
  textLayer.style.height = drawH + 'px'
  return {drawW, drawH}
}

function clearOverlay(){
  ctx.clearRect(0,0,overlayCanvas.width,overlayCanvas.height)
  redactRects = redactRects.filter(r => r.page !== currentPageIndex)
  textLayer.innerHTML = ''
  textBoxes = textBoxes.filter(t => t.page !== currentPageIndex)
}

// ---------- file handling ----------
fileInput.addEventListener('change', ev => {
  if (ev.target.files.length > 0) {
    handleFiles([...ev.target.files]);
    // Update selected file for export functionality
    selectedFile = ev.target.files[0];
    const fileName = document.createElement('div');
    fileName.className = 'file-name';
    fileName.textContent = `Selected: ${selectedFile.name}`;
    dropZone.appendChild(fileName);
  }
})

;['dragenter','dragover','dragleave','drop'].forEach(ev => {
  dropZone.addEventListener(ev, e => {
    e.preventDefault(); e.stopPropagation()
    if(ev === 'drop'){
      const dt = e.dataTransfer
      handleFiles([...dt.files])
      // Update selected file for export functionality
      if (dt.files.length > 0) {
        selectedFile = dt.files[0];
        const fileName = document.createElement('div');
        fileName.className = 'file-name';
        fileName.textContent = `Selected: ${selectedFile.name}`;
        dropZone.appendChild(fileName);
      }
    }
  })
})

async function handleFiles(files){
  // Reset imageInputs for conversion
  for(const f of files){
    if(f.type.startsWith('image/')){
      imageInputs.push(f)
    } else if(f.type === 'application/pdf'){
      await loadPdfFile(f)
    }
  }
  // Also show images as individual "docs" for preview/convert-to-pdf
  for(const f of files){
    if(f.type.startsWith('image/')){
      await loadImageFile(f)
    }
  }
  if(documents.length > 0 && currentDocIndex === -1){
    currentDocIndex = 0; currentPageIndex = 0; renderCurrentPage()
  }
  refreshPagesList()
}

async function loadPdfFile(file){
  const array = await file.arrayBuffer()
  const uint8 = new Uint8Array(array)
  const loading = await pdfjsLib.getDocument({data:uint8}).promise
  const pages = []
  for(let p=1;p<=loading.numPages;p++){
    const page = await loading.getPage(p)
    const viewport = page.getViewport({scale:1})
    // render to an offscreen canvas at 1x (we will scale to fit)
    const off = document.createElement('canvas')
    off.width = viewport.width
    off.height = viewport.height
    const offCtx = off.getContext('2d')
    await page.render({canvasContext:offCtx, viewport}).promise
    pages.push({canvas:off, originalWidth:viewport.width, originalHeight:viewport.height})
  }
  documents.push({type:'pdf', file, pages, raw:uint8})
}

async function loadImageFile(file){
  const img = new Image()
  const url = URL.createObjectURL(file)
  await new Promise(r => { img.onload = r; img.src = url })
  const off = document.createElement('canvas')
  off.width = img.naturalWidth
  off.height = img.naturalHeight
  const c = off.getContext('2d')
  c.drawImage(img,0,0)
  documents.push({type:'image', file, pages:[{canvas:off, originalWidth:off.width, originalHeight:off.height}]})
  URL.revokeObjectURL(url)
}

function refreshPagesList(){
  pagesList.innerHTML = ''
  documents.forEach((doc, di) => {
    doc.pages.forEach((p,pi)=>{
      const el = document.createElement('div')
      el.className = 'pageThumb'
      el.innerText = `${doc.type.toUpperCase()} ${di+1}:${pi+1}`
      el.onclick = () => { currentDocIndex = di; currentPageIndex = pi; renderCurrentPage() }
      pagesList.appendChild(el)
    })
  })
}

// ---------- rendering ----------
function renderCurrentPage(){
  if(currentDocIndex < 0 || !documents[currentDocIndex]) {
    pageInfo.textContent = 'No document loaded'
    baseCtx.clearRect(0,0,baseCanvas.width,baseCanvas.height)
    overlayCanvas.width = 0; overlayCanvas.height = 0
    return
  }
  const pageObj = documents[currentDocIndex].pages[currentPageIndex]
  // fit into container
  const wrap = document.querySelector('.canvasWrap')
  const size = fitCanvasesTo(wrap.clientWidth, wrap.clientHeight, pageObj.originalWidth, pageObj.originalHeight)
  // draw base image scaled
  baseCtx.clearRect(0,0,baseCanvas.width,baseCanvas.height)
  baseCtx.drawImage(pageObj.canvas, 0, 0, pageObj.canvas.width, pageObj.canvas.height, 0, 0, size.drawW, size.drawH)
  // reset overlay for this page
  ctx.clearRect(0,0,overlayCanvas.width,overlayCanvas.height)
  drawExistingAnnotations()
  pageInfo.textContent = `Doc ${currentDocIndex+1} • Page ${currentPageIndex+1} / ${documents[currentDocIndex].pages.length}`
}

// draw saved redaction rectangles and text boxes for current page
function drawExistingAnnotations(){
  // redactions
  ctx.save()
  ctx.fillStyle = '#000'
  ctx.globalAlpha = 0.95
  redactRects.filter(r => r.page === currentPageIndex && r.doc === currentDocIndex).forEach(r=>{
    ctx.fillRect(r.x,r.y,r.w,r.h)
    // show DOM rect
    let el = document.createElement('div')
    el.className = 'redactRect'
    el.style.left = r.x + 'px'; el.style.top = r.y + 'px'; el.style.width = r.w + 'px'; el.style.height = r.h + 'px'
    el.dataset.page = r.page
    textLayer.appendChild(el)
  })
  ctx.restore()
  // text boxes
  textBoxes.filter(t => t.page === currentPageIndex && t.doc === currentDocIndex).forEach(tb=>{
    createTextBoxElement(tb)
  })
}

// create DOM element for a saved text box (used when rendering existing annotations)
function createTextBoxElement(tb){
  if(!tb) return
  // reuse existing element if present
  if(tb.el && tb.el.parentElement === textLayer) return
  const el = tb.el || document.createElement('textarea')
  el.className = 'textbox'
  el.style.position = 'absolute'
  el.style.left = (tb.x || 0) + 'px'
  el.style.top = (tb.y || 0) + 'px'
  el.style.width = (tb.w || 150) + 'px'
  el.style.height = (tb.h || 40) + 'px'
  el.value = tb.text || ''
  el.placeholder = 'Type...'
  el.addEventListener('input', ()=> tb.text = el.value)
  el.addEventListener('blur', ()=> tb.text = el.value)
  el.addEventListener('keydown', (ev)=> { if(ev.key === 'Escape') el.blur() })
  textLayer.appendChild(el)
  tb.el = el
}

// ---------- annotation interactions ----------
overlayCanvas.addEventListener('pointerdown', e=>{
  if(tool !== 'draw' && tool !== 'redact' && tool !== 'text') return
  const rect = overlayCanvas.getBoundingClientRect()
  const x = e.clientX - rect.left
  const y = e.clientY - rect.top
  if(tool === 'draw'){
    drawing = true; lastPos = {x,y}
    ctx.strokeStyle = drawColor; ctx.lineWidth = drawWidth; ctx.lineJoin = 'round'; ctx.lineCap = 'round'
    ctx.beginPath(); ctx.moveTo(x,y)
  } else if(tool === 'redact'){
    drawing = true; lastPos = {x,y}
  } else if(tool === 'text'){
    // create a new editable text box
    const el = document.createElement('textarea')
    el.className = 'textbox'
    el.style.left = x + 'px'; el.style.top = y + 'px'; el.rows = 2; el.cols = 20
    el.placeholder = 'Type...'
    el.contentEditable = true
    el.style.pointerEvents = 'auto'
    textLayer.appendChild(el)
    const tb = {x,y,w:150,h:40,text:'',page:currentPageIndex,doc:currentDocIndex,el}
    textBoxes.push(tb)
    // allow editing
    el.addEventListener('input', ()=> tb.text = el.value)
    el.addEventListener('blur', ()=> tb.text = el.value)
    el.addEventListener('keydown', (ev)=> { if(ev.key === 'Escape') el.blur() })
    el.focus()
  }
})

overlayCanvas.addEventListener('pointermove', e=>{
  if(!drawing) return
  const rect = overlayCanvas.getBoundingClientRect()
  const x = e.clientX - rect.left
  const y = e.clientY - rect.top
  if(tool === 'draw'){
    ctx.lineTo(x,y); ctx.stroke()
    lastPos = {x,y}
  } else if(tool === 'redact'){
    // show rubber band
    renderRubberBand(lastPos.x,lastPos.y,x-lastPos.x,y-lastPos.y)
  }
})

overlayCanvas.addEventListener('pointerup', e=>{
  if(!drawing) return
  drawing = false
  const rect = overlayCanvas.getBoundingClientRect()
  const x = e.clientX - rect.left
  const y = e.clientY - rect.top
  if(tool === 'redact'){
    const x0 = Math.min(lastPos.x,x); const y0 = Math.min(lastPos.y,y)
    const w = Math.abs(x-lastPos.x); const h = Math.abs(y-lastPos.y)
    redactRects.push({x:x0,y:y0,w,h,page:currentPageIndex,doc:currentDocIndex})
    // render final
    ctx.fillStyle = '#000'; ctx.globalAlpha = 0.95; ctx.fillRect(x0,y0,w,h)
    // DOM rect for easy visibility
    const el = document.createElement('div')
    el.className = 'redactRect'
    el.style.left = x0 + 'px'; el.style.top = y0 + 'px'; el.style.width = w + 'px'; el.style.height = h + 'px'
    textLayer.appendChild(el)
  } else if(tool === 'draw'){
    // finished freehand - nothing else to do (we keep strokes on overlay)
  }
})

function renderRubberBand(x,y,w,h){
  // clear previous overlay strokes temporarily (only for rubber band)
  ctx.clearRect(0,0,overlayCanvas.width,overlayCanvas.height)
  // redraw saved redactions and textBoxes first
  drawExistingAnnotations()
  ctx.save()
  ctx.fillStyle = 'rgba(0,0,0,0.6)'
  ctx.fillRect(x,y,w,h)
  ctx.restore()
}

// clear button
document.querySelectorAll('.tool').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    const t = btn.dataset.tool
    if(t === 'clear'){
      // clear overlay annotations for current doc+page
      ctx.clearRect(0,0,overlayCanvas.width,overlayCanvas.height)
      // remove redactions for current page
      redactRects = redactRects.filter(r => !(r.doc === currentDocIndex && r.page === currentPageIndex))
      textBoxes = textBoxes.filter(t => !(t.doc === currentDocIndex && t.page === currentPageIndex))
      textLayer.innerHTML = ''
      return
    }
    setTool(t)
  })
})

// navigation
prevBtn.addEventListener('click', ()=> {
  if(currentPageIndex > 0) currentPageIndex--, renderCurrentPage()
})
nextBtn.addEventListener('click', ()=> {
  if(currentDocIndex < 0) return
  if(currentPageIndex < documents[currentDocIndex].pages.length - 1) currentPageIndex++, renderCurrentPage()
})

// download current page image
downloadPageImg.addEventListener('click', ()=>{
  if(!baseCanvas.width) return
  const q = parseFloat(qualityRange.value)
  baseCanvas.toBlob(blob=>{
    downloadBlob(blob, `page-${currentDocIndex+1}-${currentPageIndex+1}.jpg`)
  }, 'image/jpeg', q)
})

// ---------- conversion/export ----------
async function imagesToPdf(imagesFiles){
  try {
    const pdfDoc = await PDFLib.PDFDocument.create()
    for(const f of imagesFiles){
      if (!f.type.startsWith('image/')) {
        console.error('Invalid file type:', f.type);
        continue;
      }
      const data = await f.arrayBuffer()
      // compress using canvas quickly based on selected quality
      const imgBlob = new Blob([data], {type: f.type})
      const imgUrl = URL.createObjectURL(imgBlob)
      const img = await loadImage(imgUrl)
      URL.revokeObjectURL(imgUrl)
      // get mime type
      const mime = f.type
      let embedded
      try {
        if(mime === 'image/png') {
          embedded = await pdfDoc.embedPng(await toArrayBuffer(img))
        } else {
          embedded = await pdfDoc.embedJpg(await toArrayBuffer(img))
        }
        const page = pdfDoc.addPage([embedded.width, embedded.height])
        page.drawImage(embedded, {x:0,y:0,width:embedded.width,height:embedded.height})
      } catch (err) {
        console.error('Error embedding image:', err);
        alert(`Error processing image: ${f.name}`);
      }
    }
    const uint8 = await pdfDoc.save()
    return new Blob([uint8], {type:'application/pdf'})
  } catch (err) {
    console.error('Error creating PDF:', err);
    alert('Error creating PDF. Please check console for details.');
    return null;
  }
}

async function pdfPagesToImages(pdfDocUint8){
  // pdfDocUint8 = Uint8Array
  const loading = await pdfjsLib.getDocument({data:pdfDocUint8}).promise
  const images = []
  for(let p=1;p<=loading.numPages;p++){
    const page = await loading.getPage(p)
    const viewport = page.getViewport({scale:1})
    const off = document.createElement('canvas')
    off.width = viewport.width; off.height = viewport.height
    const offCtx = off.getContext('2d')
    await page.render({canvasContext:offCtx, viewport}).promise
    images.push(off)
  }
  return images
}

async function exportMergedPdf(){
  // For each page in current document, merge base + overlay into one image, then create PDF
  if(currentDocIndex < 0) return
  const pdfDoc = await PDFLib.PDFDocument.create()
  const q = parseFloat(qualityRange.value)
  // for every page in the document (not only current) we will produce image from base canvas scaled from stored page canvases + overlay annotations per page
  const doc = documents[currentDocIndex]
  for(let pi=0; pi<doc.pages.length; pi++){
    // render base at original resolution
    const base = doc.pages[pi].canvas
    const mergeCanvas = document.createElement('canvas')
    mergeCanvas.width = base.width
    mergeCanvas.height = base.height
    const mergeCtx = mergeCanvas.getContext('2d')
    mergeCtx.drawImage(base,0,0)
    // apply annotations for this page if any: we must scale markup that was created in rendered size
    // compute scale between displayed overlay and original
    // displayed draw size used when rendering was fitCanvasesTo - we used scale ratio; approximate by comparing baseCanvas size to original page size for the current render session
    const displayedW = baseCanvas.width
    const scale = base.width / displayedW
    // draw saved draw strokes by re-drawing overlay pixels (we'll copy overlay from an in-memory scaled canvas)
    // Create a temporary canvas sized like displayed overlay and draw overlay content onto scaled merge
    // First, create displayed overlay snapshot for that page:
    // To simplify: we'll reconstruct overlay by redrawing saved annotation arrays (redactRects + textBoxes). Freehand stroke pixels are directly on overlayCanvas only and not saved per-page; for simplicity we copy overlayCanvas only when the page is current.
    if(pi === currentPageIndex){
      // capture overlayCanvas pixels, scale to original resolution and draw
      const overlayData = overlayCanvas.toDataURL('image/png')
      const ovImg = await loadImage(overlayData)
      mergeCtx.drawImage(ovImg,0,0, overlayCanvas.width, overlayCanvas.height, 0, 0, base.width, base.height)
      // textBoxes: render text into merge
      textBoxes.filter(t => t.page === pi && t.doc === currentDocIndex).forEach(tb=>{
        mergeCtx.fillStyle = 'white'
        mergeCtx.font = `${Math.max(12, Math.round(12*scale))}px sans-serif`
        mergeCtx.fillText(tb.text || '', Math.round(tb.x*scale), Math.round((tb.y+12)*scale))
      })
    } else {
      // Not the current page: only apply redact rects that belong to that page
      redactRects.filter(r => r.page === pi && r.doc === currentDocIndex).forEach(r=>{
        mergeCtx.fillStyle = '#000'
        mergeCtx.fillRect(Math.round(r.x*scale), Math.round(r.y*scale), Math.round(r.w*scale), Math.round(r.h*scale))
      })
      // textBoxes on other pages:
      textBoxes.filter(t => t.page === pi && t.doc === currentDocIndex).forEach(tb=>{
        mergeCtx.fillStyle = 'white'
        mergeCtx.font = `${Math.max(12, Math.round(12*scale))}px sans-serif`
        mergeCtx.fillText(tb.text || '', Math.round(tb.x*scale), Math.round((tb.y+12)*scale))
      })
    }

    // compress via toBlob
    const blob = await new Promise(res=> mergeCanvas.toBlob(res,'image/jpeg', q))
    const array = await blob.arrayBuffer()
    const imgEmbed = await PDFLib.LowerLevel.PDFImageFactory.create(pdfDoc, new Uint8Array(array))
    const page = pdfDoc.addPage([mergeCanvas.width, mergeCanvas.height])
    page.drawImage(imgEmbed, {x:0,y:0,width:mergeCanvas.width,height:mergeCanvas.height})
  }
  const out = await pdfDoc.save()
  const b = new Blob([out], {type:'application/pdf'})
  downloadBlob(b, 'edited.pdf')
}

// helper to download blob
function downloadBlob(blob, filename){
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename
  document.body.appendChild(a); a.click()
  setTimeout(()=>{ URL.revokeObjectURL(url); a.remove() }, 500)
}

// ---------- UI actions ----------
downloadPdfBtn.addEventListener('click', async () => {
  try {
    await exportMergedPdf();
  } catch (err) {
    console.error('Error exporting PDF:', err);
    alert('Error exporting PDF. Please try again.');
  }
})

imgToPdfBtn.addEventListener('click', async () => {
  try {
    if (imageInputs.length === 0) {
      // Check if there are files in the fileInput
      const files = fileInput.files;
      if (files.length === 0) {
        alert('No images queued — drag image files or use the upload button first');
        return;
      }
      // Filter only image files
      const imageFiles = [...files].filter(f => f.type.startsWith('image/'));
      if (imageFiles.length === 0) {
        alert('No valid image files found');
        return;
      }
      const blob = await imagesToPdf(imageFiles);
      if (blob) {
        downloadBlob(blob, 'images-to-pdf.pdf');
      }
    } else {
      const blob = await imagesToPdf(imageInputs);
      if (blob) {
        downloadBlob(blob, 'images-to-pdf.pdf');
      }
    }
  } catch (err) {
    console.error('Error converting images to PDF:', err);
    alert('Error converting images to PDF. Please try again.');
  }
})

pdfToImgBtn.addEventListener('click', async ()=>{
  // convert first document that is PDF
  const doc = documents.find(d=>d.type === 'pdf')
  if(!doc){ alert('No PDF loaded') ; return }
  // render each page canvas to blob and download zipped name per page (sequential downloads)
  for(let i=0;i<doc.pages.length;i++){
    const c = doc.pages[i].canvas
    const q = parseFloat(qualityRange.value)
    await new Promise(r=> c.toBlob(blob=>{
      downloadBlob(blob, `doc-page-${i+1}.jpg`); r()
    }, 'image/jpeg', q))
  }
})

compressBtn.addEventListener('click', async ()=>{
  // quick compress and export current doc (if PDF, convert pages to compressed images and rebuild PDF)
  if(currentDocIndex < 0){ alert('No document loaded'); return }
  const doc = documents[currentDocIndex]
  if(doc.type === 'image'){
    // compress single image
    const f = doc.file
    const options = {maxSizeMB: 1, useWebWorker: true, initialQuality: parseFloat(qualityRange.value)}
    const compressed = await imageCompression(f, options)
    downloadBlob(compressed, `compressed-${f.name}`)
  } else {
    // PDF -> rebuild with compressed page images
    const q = parseFloat(qualityRange.value)
    const pdfDoc = await PDFLib.PDFDocument.create()
    for(let i=0;i<doc.pages.length;i++){
      const pageCanvas = doc.pages[i].canvas
      // produce jpeg with chosen quality
      const blob = await new Promise(r => pageCanvas.toBlob(r,'image/jpeg', q))
      const array = await blob.arrayBuffer()
      const imgEmbed = await PDFLib.PDFImageFactory?.fromUint8Array ? // fallback attempt
        await pdfDoc.embedJpg(new Uint8Array(array)) : await pdfDoc.embedJpg(new Uint8Array(array))
      const page = pdfDoc.addPage([pageCanvas.width, pageCanvas.height])
      page.drawImage(imgEmbed, {x:0,y:0,width:pageCanvas.width,height:pageCanvas.height})
    }
    const out = await pdfDoc.save()
    downloadBlob(new Blob([out], {type:'application/pdf'}), 'compressed.pdf')
  }
})

// small helpers
function loadImage(src){ return new Promise((res,rej)=>{ const i=new Image(); i.onload=()=>res(i); i.onerror=rej; i.src=src }) }
async function toArrayBuffer(img){
  // convert HTMLElement Image to ArrayBuffer (JPEG)
  const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight
  const cx = c.getContext('2d'); cx.drawImage(img,0,0)
  return await new Promise(r=> c.toBlob(b=> b.arrayBuffer().then(r),'image/jpeg',0.95))
}

// ---------- init ----------
setTool('pan') // default
// small window resize handling
window.addEventListener('resize', ()=> renderCurrentPage())

// click upload handlers
const uploadFileInput = document.querySelector('.btn input[type=file]');
if (uploadFileInput) {
  uploadFileInput.addEventListener('click', (e) => e.stopPropagation());
}
const uploadButton = document.querySelector('.btn');
if (uploadButton) {
  uploadButton.addEventListener('click', () => {}); // noop to avoid issues
}

// wire file input (keep the input in DOM so label works)
const uploadInput = document.querySelector('.btn input[type=file]');

// expose some debugging on window if needed
window._docState = () => ({documents, currentDocIndex, currentPageIndex, redactRects, textBoxes})

console.info('Futuristic PDF & Image Studio ready.')
// Additional UI handlers for upload/export buttons
const uploadBtn = document.getElementById("uploadBtn");
const exportBtn = document.getElementById("exportBtn");
const dropArea = document.getElementById("dropArea") || document.body;

// selectedFile is declared above and reused

if (uploadBtn) {
  uploadBtn.addEventListener("click", () => fileInput.click());
}

if (exportBtn) {
  exportBtn.addEventListener("click", () => {
    if (!selectedFile) {
      alert("No file to export. Please upload one first!");
      return;
    }
    const blob = new Blob([selectedFile], { type: selectedFile.type });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `exported_${selectedFile.name}`;
    link.click();
    URL.revokeObjectURL(link.href);
  });
}

// Prevent default drag behavior
dropArea.addEventListener("dragover", (e) => {
  e.preventDefault();
  e.stopPropagation();
});
