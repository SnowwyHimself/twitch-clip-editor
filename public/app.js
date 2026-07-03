const tabButtons = document.querySelectorAll('.tab-btn');
const tabPanels = document.querySelectorAll('.tab-panel');
const zoomSlider = document.getElementById('zoom-slider');
const zoomValue = document.getElementById('zoom-value');
const blurSlider = document.getElementById('blur-slider');
const blurValue = document.getElementById('blur-value');
const speedSlider = document.getElementById('speed-slider');
const speedValue = document.getElementById('speed-value');
const generateBtn = document.getElementById('generate-btn');
const statusArea = document.getElementById('status-area');
const statusText = document.getElementById('status-text');
const statusBar = document.getElementById('status-bar');
const resultArea = document.getElementById('result-area');
const resultVideo = document.getElementById('result-video');
const downloadLink = document.getElementById('download-link');
const clipUrlInput = document.getElementById('clip-url');
const clipFileInput = document.getElementById('clip-file');
const captionTextInput = document.getElementById('caption-text');
const captionStyleButtons = document.querySelectorAll('[data-caption-style]');
const mirrorToggle = document.getElementById('mirror-toggle');

let activeTab = 'url';
let captionStyle = 'outline';
let pollHandle = null;

const STATUS_LABELS = {
  queued: 'Queued...',
  downloading: 'Downloading clip...',
  processing: 'Rendering vertical edit...',
  done: 'Done!',
};

tabButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    activeTab = btn.dataset.tab;
    tabButtons.forEach((b) => b.classList.toggle('active', b === btn));
    tabPanels.forEach((p) => p.classList.toggle('active', p.dataset.panel === activeTab));
  });
});

zoomSlider.addEventListener('input', () => {
  zoomValue.textContent = `${zoomSlider.value}%`;
});

blurSlider.addEventListener('input', () => {
  blurValue.textContent = `${blurSlider.value}%`;
});

speedSlider.addEventListener('input', () => {
  speedValue.textContent = `${parseFloat(speedSlider.value).toFixed(2)}x`;
});

captionStyleButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    captionStyle = btn.dataset.captionStyle;
    captionStyleButtons.forEach((b) => b.classList.toggle('active', b === btn));
  });
});

function isValidHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function resetOutput() {
  statusArea.classList.add('hidden');
  resultArea.classList.add('hidden');
  statusBar.classList.remove('done', 'error');
  if (pollHandle) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
}

function showStatus(status, errorMessage) {
  statusArea.classList.remove('hidden');
  statusBar.classList.remove('done', 'error');
  statusText.classList.remove('success', 'error');

  if (status === 'error') {
    statusText.textContent = errorMessage || 'Something went wrong.';
    statusText.classList.add('error');
    statusBar.classList.add('error');
  } else if (status === 'done') {
    statusText.textContent = 'Done!';
    statusText.classList.add('success');
    statusBar.classList.add('done');
  } else {
    statusText.textContent = STATUS_LABELS[status] || 'Working...';
  }
}

function showResult(outputUrl) {
  resultArea.classList.remove('hidden');
  resultVideo.src = outputUrl;
  downloadLink.href = outputUrl;
}

function setGenerating(isGenerating) {
  generateBtn.disabled = isGenerating;
  generateBtn.textContent = isGenerating ? 'Generating...' : 'Generate edit';
}

function pollStatus(jobId) {
  pollHandle = setInterval(async () => {
    try {
      const res = await fetch(`/api/status/${jobId}`);
      const job = await res.json();
      if (!res.ok) {
        throw new Error(job.error || 'Failed to fetch job status');
      }
      showStatus(job.status, job.error);
      if (job.status === 'done') {
        clearInterval(pollHandle);
        pollHandle = null;
        setGenerating(false);
        showResult(job.outputUrl);
      } else if (job.status === 'error') {
        clearInterval(pollHandle);
        pollHandle = null;
        setGenerating(false);
      }
    } catch (err) {
      clearInterval(pollHandle);
      pollHandle = null;
      setGenerating(false);
      showStatus('error', err.message);
    }
  }, 1500);
}

generateBtn.addEventListener('click', async () => {
  resetOutput();

  const zoom = parseFloat(zoomSlider.value) / 100;
  const blur = parseFloat(blurSlider.value);
  const speed = parseFloat(speedSlider.value);
  const captionText = captionTextInput.value;
  const mirror = mirrorToggle.checked;

  try {
    let jobId;

    if (activeTab === 'url') {
      const url = clipUrlInput.value.trim();
      if (!url) {
        showStatus('error', 'Please paste a clip URL.');
        return;
      }
      if (!isValidHttpUrl(url)) {
        showStatus('error', 'Please enter a valid clip URL (starting with http:// or https://).');
        return;
      }
      setGenerating(true);
      const res = await fetch('/api/process-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, zoom, blur, captionText, captionStyle, mirror, speed }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start job');
      jobId = data.jobId;
    } else {
      const file = clipFileInput.files[0];
      if (!file) {
        showStatus('error', 'Please choose a video file.');
        return;
      }
      setGenerating(true);
      const formData = new FormData();
      formData.append('video', file);
      formData.append('zoom', zoom);
      formData.append('blur', blur);
      formData.append('captionText', captionText);
      formData.append('captionStyle', captionStyle);
      formData.append('mirror', mirror);
      formData.append('speed', speed);
      const res = await fetch('/api/process-upload', {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start job');
      jobId = data.jobId;
    }

    showStatus('queued');
    pollStatus(jobId);
  } catch (err) {
    setGenerating(false);
    showStatus('error', err.message);
  }
});
