// SyncCinema Client Core
let ws = null;
let currentRoomId = null;
let userNickname = null;
let myUserId = null;

// Anti-echo programmatic state locks (Completely timeout-independent to solve playback loop glitches!)
let expectedPlayingState = null; // null, true (playing), false (paused) [HTML5]
let expectedTimeState = null;    // null, number (target seek time) [HTML5]
let expectedYtState = null;      // null, YT.PlayerState.PLAYING, YT.PlayerState.PAUSED [YouTube]

// Coordinated Buffering Debouncer (Blocks micro-seeks from triggering auto-pause cycles!)
let bufferDebounceTimeout = null;
let isSentBuffering = false;

// Player Dual-Architecture State
let currentPlayerMode = 'html5'; // 'html5' or 'youtube'
let ytPlayer = null;
let ytReady = false;
let pendingYtVideoId = null;

// WebRTC Calling State
let localStream = null;
let peerConnections = {}; // Map of targetUserId -> RTCPeerConnection
let callActive = false;
let micEnabled = true;
let camEnabled = true;

// STUN Server Configs (Google public STUNs)
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ]
};

// Onboarding Form Elements
const landingPage = document.getElementById('landing-page');
const theatrePage = document.getElementById('theatre-page');
const inputNickname = document.getElementById('input-nickname');
const inputRoomCode = document.getElementById('input-room-code');
const btnCreateRoom = document.getElementById('btn-create-room');
const btnJoinRoom = document.getElementById('btn-join-room');

// Header Profile & Control Elements
const roomBadgeHeader = document.getElementById('room-badge-header');
const videoControlsHeader = document.getElementById('video-controls-header');
const userProfileHeader = document.getElementById('user-profile-header');
const displayUsernameHeader = document.getElementById('display-username-header');
const btnLeaveRoom = document.getElementById('btn-leave-room');
const btnPresetsToggle = document.getElementById('btn-presets-toggle');
const presetsDropdown = document.getElementById('presets-dropdown');
const btnToggleCall = document.getElementById('btn-toggle-call');

// Video Player & Config Elements
const sharedVideo = document.getElementById('shared-video');
const playerContainer = document.getElementById('player-container');
const displayRoomCode = document.getElementById('display-room-code');
const displayVideoTitle = document.getElementById('display-video-title');
const inputVideoUrl = document.getElementById('input-video-url');
const formChangeVideo = document.getElementById('form-change-video');
const presetsWrapper = document.getElementById('presets-wrapper');
const btnFullscreenToggle = document.getElementById('btn-fullscreen-toggle');

// Shared Room Folder & Upload Elements
const roomFilesList = document.getElementById('room-files-list');
const inputFileUpload = document.getElementById('input-file-upload');
const uploadProgressContainer = document.getElementById('upload-progress-container');
const uploadProgressBar = document.getElementById('upload-progress-bar');

// WebRTC calling UI Elements
const callControlsOverlay = document.getElementById('call-controls-overlay');
const btnToggleMic = document.getElementById('btn-toggle-mic');
const btnToggleCam = document.getElementById('btn-toggle-cam');
const btnHangup = document.getElementById('btn-hangup');

// Live Chat & Viewers Elements
const viewersList = document.getElementById('viewers-list');
const userCountBadge = document.getElementById('user-count');
const chatMessagesContainer = document.getElementById('chat-messages-container');
const chatInputForm = document.getElementById('chat-input-form');
const chatInput = document.getElementById('chat-input');

// Diagnostic Elements
const wsStatusDot = document.getElementById('ws-status-dot');
const wsStatusText = document.getElementById('ws-status-text');
const syncLagIndicator = document.getElementById('sync-lag-indicator');
const btnCopyLink = document.getElementById('btn-copy-link');

// Load YouTube IFrame Player API Script Dynamically
const tag = document.createElement('script');
tag.src = "https://www.youtube.com/iframe_api";
const firstScriptTag = document.getElementsByTagName('script')[0];
firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);

// Global YouTube API Ready Callback
window.onYouTubeIframeAPIReady = () => {
  ytPlayer = new YT.Player('yt-player', {
    width: '100%',
    height: '100%',
    playerVars: {
      autoplay: 0,
      controls: 1,
      rel: 0,
      showinfo: 0,
      modestbranding: 1,
      disablekb: 0,
      fs: 0
    },
    events: {
      'onReady': onYouTubePlayerReady,
      'onStateChange': onYouTubePlayerStateChange
    }
  });
};

function onYouTubePlayerReady(event) {
  ytReady = true;
  console.log("YouTube Player API Ready.");
  if (pendingYtVideoId) {
    loadYouTubeVideo(pendingYtVideoId);
    pendingYtVideoId = null;
  }
}

// Track YouTube Sync Playbacks (ExpectedYtState consume + 800ms Debounced Buffering)
function onYouTubePlayerStateChange(event) {
  if (currentPlayerMode !== 'youtube' || !ytReady) return;

  const currentTime = ytPlayer.getCurrentTime();

  // If this state change matches our programmatic action, consume and skip!
  if (expectedYtState !== null) {
    if (event.data === expectedYtState) {
      expectedYtState = null; // State consumed!
      
      // Clear buffering timers
      if (bufferDebounceTimeout) {
        clearTimeout(bufferDebounceTimeout);
        bufferDebounceTimeout = null;
      }
      if (isSentBuffering) {
        isSentBuffering = false;
        sendSyncMessage({ type: 'buffered-ready' }); // Auto-Resume trigger
      } else {
        // Guarantee synchronization ready status is fired to server
        sendSyncMessage({ type: 'buffered-ready' });
      }
    }
    return;
  }

  // Genuine user click/actions on YouTube Player
  if (event.data === YT.PlayerState.PLAYING) {
    // Clear buffer timeouts if user manually starts playing
    if (bufferDebounceTimeout) {
      clearTimeout(bufferDebounceTimeout);
      bufferDebounceTimeout = null;
    }
    if (isSentBuffering) {
      isSentBuffering = false;
      sendSyncMessage({ type: 'buffered-ready' });
    }

    sendSyncMessage({ type: 'play', time: currentTime });
    sendSyncMessage({ type: 'buffered-ready' });

  } else if (event.data === YT.PlayerState.PAUSED) {
    if (bufferDebounceTimeout) {
      clearTimeout(bufferDebounceTimeout);
      bufferDebounceTimeout = null;
    }
    if (isSentBuffering) {
      isSentBuffering = false;
      sendSyncMessage({ type: 'buffered-ready' });
    }

    sendSyncMessage({ type: 'pause', time: currentTime });

  } else if (event.data === YT.PlayerState.BUFFERING) {
    // Apply 800ms Debounce limit to YouTube as well!
    if (bufferDebounceTimeout) clearTimeout(bufferDebounceTimeout);
    bufferDebounceTimeout = setTimeout(() => {
      isSentBuffering = true;
      sendSyncMessage({ type: 'buffering' });
    }, 800);
  }
}

function loadYouTubeVideo(videoId) {
  if (!ytReady || !ytPlayer) {
    pendingYtVideoId = videoId;
    return;
  }
  expectedYtState = YT.PlayerState.PAUSED; // Default loading expectation
  ytPlayer.cueVideoById(videoId);
}

// Helper: Extract YouTube 11-char ID
function extractYouTubeId(url) {
  const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
  const match = url.match(regExp);
  return (match && match[2].length === 11) ? match[2] : null;
}

// Unified Dual Player Resource Loader & Prefetch Engine
function loadVideo(url, title) {
  const ytId = extractYouTubeId(url);

  // Dynamic Head Prefetch Injector to cache direct movie bytes in advance
  let existingPrefetch = document.getElementById('active-video-prefetch');
  if (existingPrefetch) {
    existingPrefetch.remove();
  }

  if (ytId) {
    currentPlayerMode = 'youtube';
    
    // Hide standard video and custom controls
    sharedVideo.style.display = 'none';
    const ctrlBar = document.getElementById('custom-video-controls');
    if (ctrlBar) ctrlBar.style.display = 'none';
    sharedVideo.pause();
    sharedVideo.src = "";
    
    // Show YouTube div
    document.getElementById('yt-player').style.display = 'block';
    loadYouTubeVideo(ytId);
    
    displayVideoTitle.innerText = title || "YouTube Video";
  } else {
    currentPlayerMode = 'html5';
    
    // Hide YouTube
    document.getElementById('yt-player').style.display = 'none';
    if (ytReady && ytPlayer) {
      try { ytPlayer.pauseVideo(); } catch (e) {}
    }
    
    // Show HTML5 and custom controls
    sharedVideo.style.display = 'block';
    const ctrlBar = document.getElementById('custom-video-controls');
    if (ctrlBar) ctrlBar.style.display = 'flex';
    const absoluteUrl = new URL(url, window.location.href).href;
    if (sharedVideo.src !== absoluteUrl) {
      sharedVideo.src = absoluteUrl;
    }

    // Inject aggressive link prefetching header
    const prefetchLink = document.createElement('link');
    prefetchLink.id = 'active-video-prefetch';
    prefetchLink.rel = 'prefetch';
    prefetchLink.as = 'video';
    prefetchLink.href = url;
    document.head.appendChild(prefetchLink);

    // Dynamic HTML5 player aggressive preloading
    sharedVideo.preload = "auto";
    sharedVideo.load();
    
    displayVideoTitle.innerText = title || "External Video Source";
  }

  updatePresetsHighlight(url);
}

// 1. Initial Page Route & Nickname Restore
window.addEventListener('DOMContentLoaded', () => {
  const savedNickname = localStorage.getItem('sync_cinema_nickname');
  if (savedNickname) {
    inputNickname.value = savedNickname;
  }

  // Handle direct sharing URLs
  const pathParts = window.location.pathname.split('/');
  const roomIndex = pathParts.indexOf('room');
  if (roomIndex !== -1 && pathParts[roomIndex + 1]) {
    const directRoomId = pathParts[roomIndex + 1].toUpperCase();
    inputRoomCode.value = directRoomId;
    showToast(`Sharing Link Detected! Welcome to Room: ${directRoomId}`);
  }
});

// Watch browser Back/Forward clicks
window.addEventListener('popstate', () => {
  const pathParts = window.location.pathname.split('/');
  const roomIndex = pathParts.indexOf('room');
  if (roomIndex === -1 || !pathParts[roomIndex + 1]) {
    disconnectRoom();
  }
});

// Toggle Presets Dropdown
btnPresetsToggle.addEventListener('click', (e) => {
  e.stopPropagation();
  presetsDropdown.classList.toggle('show');
});

// Close presets dropdown when clicking outside
document.addEventListener('click', (e) => {
  if (presetsDropdown && !presetsDropdown.contains(e.target) && e.target !== btnPresetsToggle) {
    presetsDropdown.classList.remove('show');
  }
});

// Display Toast Alert
function showToast(text) {
  const toast = document.getElementById('toast-message');
  toast.innerText = text;
  toast.classList.add('show');
  setTimeout(() => {
    toast.classList.remove('show');
  }, 2500);
}

// 2. Landing Flow Action Handlers
btnCreateRoom.addEventListener('click', () => {
  const nickname = inputNickname.value.trim();
  if (!nickname) {
    inputNickname.focus();
    showToast("Please enter a nickname first!");
    return;
  }
  
  localStorage.setItem('sync_cinema_nickname', nickname);
  userNickname = nickname;

  const code = Math.random().toString(36).substring(2, 8).toUpperCase();
  currentRoomId = code;

  window.history.pushState({ roomId: code }, "", `/room/${code}`);
  connectToRoom(code, nickname);
});

btnJoinRoom.addEventListener('click', () => {
  const nickname = inputNickname.value.trim();
  const code = inputRoomCode.value.trim().toUpperCase();

  if (!nickname) {
    inputNickname.focus();
    showToast("Please enter a nickname first!");
    return;
  }
  if (!code) {
    inputRoomCode.focus();
    showToast("Please enter the room code!");
    return;
  }

  localStorage.setItem('sync_cinema_nickname', nickname);
  userNickname = nickname;
  currentRoomId = code;

  window.history.pushState({ roomId: code }, "", `/room/${code}`);
  connectToRoom(code, nickname);
});

btnLeaveRoom.addEventListener('click', () => {
  disconnectRoom();
  window.history.pushState({}, "", "/");
});

// 3. WebSocket Realtime Sync Logic & WebRTC Signaling
function connectToRoom(roomId, nickname) {
  // Update view states
  landingPage.classList.remove('active');
  theatrePage.classList.add('active');
  
  // Show header controls & info
  roomBadgeHeader.style.display = 'flex';
  videoControlsHeader.style.display = 'flex';
  userProfileHeader.style.display = 'flex';
  displayUsernameHeader.innerText = nickname;
  btnLeaveRoom.style.display = 'inline-flex';
  btnToggleCall.style.display = 'inline-flex';
  
  displayRoomCode.innerText = roomId;

  // Establish connection details
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host;
  const wsUrl = `${protocol}//${host}/ws?roomId=${roomId}&username=${encodeURIComponent(nickname)}`;

  // Status visual setup
  wsStatusDot.className = 'status-dot syncing';
  wsStatusText.innerText = "Syncing...";

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    wsStatusDot.className = 'status-dot';
    wsStatusText.innerText = "Synchronized";
    showToast("Connected to synchronization server!");
  };

  ws.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data);

      switch (data.type) {
        case 'room-state':
          myUserId = data.userId;
          updateUsersList(data.users);
          updateUploadedFilesList(data.uploadedFiles || []);
          
          loadVideo(data.videoUrl, data.videoTitle);

          // Apply state when video players are loaded
          const applyState = () => {
            const latency = (Date.now() - data.lastSyncTime) / 1000;
            let targetTime = data.currentTime;
            
            if (data.isPlaying) {
              targetTime += latency;
            }
            
            if (currentPlayerMode === 'youtube' && ytReady && ytPlayer) {
              expectedYtState = data.isPlaying ? YT.PlayerState.PLAYING : YT.PlayerState.PAUSED;
              ytPlayer.seekTo(targetTime, true);
              if (data.isPlaying) {
                ytPlayer.playVideo();
              } else {
                ytPlayer.pauseVideo();
              }
            } else if (currentPlayerMode === 'html5') {
              expectedPlayingState = data.isPlaying;
              expectedTimeState = targetTime;
              sharedVideo.currentTime = targetTime;
              if (data.isPlaying) {
                sharedVideo.play().catch(e => {
                  console.log("Autoplay blocked.", e);
                  showToast("Click Play to start synced watching!");
                });
              } else {
                sharedVideo.pause();
              }
            }
          };

          if (currentPlayerMode === 'youtube') {
            if (ytReady && ytPlayer) {
              applyState();
            } else {
              const checkYt = setInterval(() => {
                if (ytReady && ytPlayer) {
                  clearInterval(checkYt);
                  applyState();
                }
              }, 100);
            }
          } else {
            if (sharedVideo.readyState >= 1) {
              applyState();
            } else {
              sharedVideo.addEventListener('loadedmetadata', applyState, { once: true });
            }
          }
          break;

        case 'user-joined':
          updateUsersList(data.users);
          appendNotification(`${data.username} joined the room.`);
          break;

        case 'user-left':
          updateUsersList(data.users);
          appendNotification(`${data.username} left the room.`);
          
          if (peerConnections[data.userId]) {
            peerConnections[data.userId].close();
            delete peerConnections[data.userId];
          }
          removeRemoteVideoElement(data.userId);
          break;

        case 'uploaded-files-update':
          updateUploadedFilesList(data.files || []);
          break;

        case 'buffering-state':
          const overlay = document.getElementById('buffering-overlay');
          const textEl = document.getElementById('buffer-overlay-text');
          if (data.isBuffering) {
            textEl.innerText = `Waiting for ${data.username} to finish buffering...`;
            overlay.classList.add('show');
          } else {
            overlay.classList.remove('show');
          }
          break;

        case 'play':
          if (currentPlayerMode === 'youtube' && ytReady && ytPlayer) {
            expectedYtState = YT.PlayerState.PLAYING;
            ytPlayer.seekTo(data.time, true);
            ytPlayer.playVideo();
          } else if (currentPlayerMode === 'html5') {
            expectedPlayingState = true;
            expectedTimeState = data.time;
            sharedVideo.currentTime = data.time;
            sharedVideo.play().catch(e => console.log(e));
          }
          appendNotification(`${data.username} played the video.`);
          break;

        case 'pause':
          if (currentPlayerMode === 'youtube' && ytReady && ytPlayer) {
            expectedYtState = YT.PlayerState.PAUSED;
            ytPlayer.seekTo(data.time, true);
            ytPlayer.pauseVideo();
          } else if (currentPlayerMode === 'html5') {
            expectedPlayingState = false;
            expectedTimeState = data.time;
            sharedVideo.currentTime = data.time;
            sharedVideo.pause();
          }
          appendNotification(`${data.username} paused the video.`);
          break;

        case 'seek':
          if (currentPlayerMode === 'youtube' && ytReady && ytPlayer) {
            // Retain active play state
            expectedYtState = (ytPlayer.getPlayerState() === YT.PlayerState.PLAYING) 
              ? YT.PlayerState.PLAYING 
              : YT.PlayerState.PAUSED;
            ytPlayer.seekTo(data.time, true);
          } else if (currentPlayerMode === 'html5') {
            expectedTimeState = data.time;
            sharedVideo.currentTime = data.time;
          }
          appendNotification(`${data.username} seeked to ${formatTime(data.time)}.`);
          break;

        case 'change-video':
          loadVideo(data.url, data.title);
          appendNotification(`${data.username} changed the video to: ${data.title}`);
          break;

        case 'chat':
          appendChatMessage(data.username, data.text, data.timestamp);
          break;

        // WebRTC Signaling Proxy Messages
        case 'webrtc-joined-call':
          appendNotification(`${data.username} started/joined the voice & video call!`);
          if (callActive) {
            initiateWebRTCConnection(data.userId, data.username);
          }
          break;

        case 'webrtc-left-call':
          appendNotification(`${data.username} left the call.`);
          removeRemoteVideoElement(data.userId);
          if (peerConnections[data.userId]) {
            peerConnections[data.userId].close();
            delete peerConnections[data.userId];
          }
          break;

        case 'webrtc-signal':
          handleIncomingWebRTCSignal(data.senderUserId, data.senderUsername, data.signal);
          break;
      }
    } catch (err) {
      console.error("Failed to parse websocket message:", err);
    }
  };

  ws.onclose = () => {
    wsStatusDot.className = 'status-dot disconnected';
    wsStatusText.innerText = "Disconnected";
    showToast("Lost connection. Refresh to reconnect!");
  };

  ws.onerror = (err) => {
    console.error("WS connection error:", err);
    wsStatusDot.className = 'status-dot disconnected';
  };
}

function disconnectRoom() {
  leaveVideoCall();
  
  if (ws) {
    ws.close();
    ws = null;
  }
  
  sharedVideo.pause();
  sharedVideo.removeAttribute('src');
  sharedVideo.load();
  
  // Hide header controls & info
  roomBadgeHeader.style.display = 'none';
  videoControlsHeader.style.display = 'none';
  userProfileHeader.style.display = 'none';
  btnLeaveRoom.style.display = 'none';
  btnToggleCall.style.display = 'none';
  presetsDropdown.classList.remove('show');
  
  // Switch back to landing page
  theatrePage.classList.remove('active');
  landingPage.classList.add('active');
  
  chatMessagesContainer.innerHTML = '';
  viewersList.innerHTML = '';
  roomFilesList.innerHTML = '';
  
  currentRoomId = null;
  myUserId = null;
  showToast("Left watch room.");
}

// 4. Send WebSocket Message
function sendSyncMessage(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

// 5. HTML5 Video Player Sync Event Listeners
sharedVideo.addEventListener('play', () => {
  if (currentPlayerMode !== 'html5') return;
  
  updateCustomPlayPauseUI(true);
  triggerPlayPauseRipple(true);

  // Consume programmatic trigger to block loop feedback!
  if (expectedPlayingState === true) {
    expectedPlayingState = null;
    return;
  }
  
  sendSyncMessage({
    type: 'play',
    time: sharedVideo.currentTime
  });
});

sharedVideo.addEventListener('pause', () => {
  if (currentPlayerMode !== 'html5') return;

  updateCustomPlayPauseUI(false);
  triggerPlayPauseRipple(false);

  if (expectedPlayingState === false) {
    expectedPlayingState = null;
    return;
  }
  
  sendSyncMessage({
    type: 'pause',
    time: sharedVideo.currentTime
  });
});

sharedVideo.addEventListener('seeking', () => {
  if (currentPlayerMode !== 'html5') return;

  if (expectedTimeState !== null && Math.abs(sharedVideo.currentTime - expectedTimeState) < 1.5) {
    expectedTimeState = null;
    return;
  }
  
  sendSyncMessage({
    type: 'seek',
    time: sharedVideo.currentTime
  });
});

// Coordinated Buffering Sync triggers (800ms Debouncer)
sharedVideo.addEventListener('waiting', () => {
  if (currentPlayerMode !== 'html5' || expectedPlayingState !== null) return;
  
  if (bufferDebounceTimeout) clearTimeout(bufferDebounceTimeout);
  
  bufferDebounceTimeout = setTimeout(() => {
    isSentBuffering = true;
    sendSyncMessage({ type: 'buffering' });
  }, 800);
});

sharedVideo.addEventListener('playing', () => {
  if (currentPlayerMode !== 'html5') return;
  
  if (bufferDebounceTimeout) {
    clearTimeout(bufferDebounceTimeout);
    bufferDebounceTimeout = null;
  }
  
  if (isSentBuffering) {
    isSentBuffering = false;
    sendSyncMessage({ type: 'buffered-ready' });
  }
});

sharedVideo.addEventListener('canplay', () => {
  if (currentPlayerMode !== 'html5') return;
  
  if (bufferDebounceTimeout) {
    clearTimeout(bufferDebounceTimeout);
    bufferDebounceTimeout = null;
  }
  
  if (isSentBuffering) {
    isSentBuffering = false;
    sendSyncMessage({ type: 'buffered-ready' });
  }
});

// Clear buffering timer as soon as seek finishes loading
sharedVideo.addEventListener('seeked', () => {
  if (currentPlayerMode !== 'html5') return;
  
  if (bufferDebounceTimeout) {
    clearTimeout(bufferDebounceTimeout);
    bufferDebounceTimeout = null;
  }
  
  if (isSentBuffering) {
    isSentBuffering = false;
    sendSyncMessage({ type: 'buffered-ready' });
  }
});

// Cinema Fullscreen Toggle
btnFullscreenToggle.addEventListener('click', toggleCinemaFullscreen);
sharedVideo.addEventListener('dblclick', (e) => {
  e.preventDefault();
  toggleCinemaFullscreen();
});

function toggleCinemaFullscreen() {
  const fsElement = document.fullscreenElement || 
                    document.webkitFullscreenElement || 
                    document.mozFullScreenElement || 
                    document.msFullScreenElement;

  if (!fsElement) {
    if (playerContainer.requestFullscreen) {
      playerContainer.requestFullscreen().then(() => {
        showToast("Cinema Mode Active!");
      }).catch(err => {
        console.log("Fullscreen failed, trying webkit:", err);
        if (playerContainer.webkitRequestFullscreen) {
          playerContainer.webkitRequestFullscreen();
        }
      });
    } else if (playerContainer.webkitRequestFullscreen) {
      playerContainer.webkitRequestFullscreen();
      showToast("Cinema Mode Active!");
    } else if (playerContainer.mozRequestFullScreen) {
      playerContainer.mozRequestFullScreen();
      showToast("Cinema Mode Active!");
    } else if (playerContainer.msRequestFullscreen) {
      playerContainer.msRequestFullscreen();
      showToast("Cinema Mode Active!");
    } else {
      showToast("Fullscreen not supported on this browser.");
    }
  } else {
    if (document.exitFullscreen) {
      document.exitFullscreen().catch(err => {
        console.log("Exit fullscreen failed, trying webkit:", err);
        if (document.webkitExitFullscreen) {
          document.webkitExitFullscreen();
        }
      });
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    } else if (document.mozCancelFullScreen) {
      document.mozCancelFullScreen();
    } else if (document.msExitFullscreen) {
      document.msExitFullscreen();
    }
  }
}

// 6. Change Video Sources (Form & Presets)
formChangeVideo.addEventListener('submit', (e) => {
  e.preventDefault();
  const url = inputVideoUrl.value.trim();
  if (!url) return;

  let title = "External Video Source";
  if (extractYouTubeId(url)) {
    title = "YouTube Video";
  } else {
    try {
      const urlObj = new URL(url);
      title = urlObj.pathname.split('/').pop() || "External Video";
      title = decodeURIComponent(title);
    } catch (err) {}
  }

  sendSyncMessage({
    type: 'change-video',
    url: url,
    title: title
  });

  inputVideoUrl.value = "";
  presetsDropdown.classList.remove('show');
});

presetsWrapper.addEventListener('click', (e) => {
  const target = e.target.closest('.preset-chip');
  if (!target) return;

  const url = target.getAttribute('data-url');
  const title = target.getAttribute('data-title');

  sendSyncMessage({
    type: 'change-video',
    url: url,
    title: title
  });

  presetsDropdown.classList.remove('show');
});

function updatePresetsHighlight(activeUrl) {
  const chips = presetsWrapper.querySelectorAll('.preset-chip');
  chips.forEach(chip => {
    if (chip.getAttribute('data-url') === activeUrl) {
      chip.classList.add('active');
    } else {
      chip.classList.remove('active');
    }
  });
}

// 7. High-Performance Direct Binary HTTP stream uploader
inputFileUpload.addEventListener('change', () => {
  const file = inputFileUpload.files[0];
  if (!file) return;
  uploadLocalFile(file);
});

function uploadLocalFile(file) {
  if (!currentRoomId || !userNickname) return;
  
  uploadProgressContainer.style.display = 'block';
  uploadProgressBar.style.width = '0%';
  showToast(`Uploading "${file.name}" to Shared Folder...`);

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/upload', true);

  // Pack transmission metadata in HTTP headers to avoid memory-heavy multipart parsing!
  xhr.setRequestHeader('x-room-id', currentRoomId);
  xhr.setRequestHeader('x-username', encodeURIComponent(userNickname));
  xhr.setRequestHeader('x-filename', encodeURIComponent(file.name));
  xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');

  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      const percentage = Math.round((e.loaded / e.total) * 100);
      uploadProgressBar.style.width = `${percentage}%`;
    }
  };

  xhr.onload = () => {
    uploadProgressContainer.style.display = 'none';
    inputFileUpload.value = '';

    if (xhr.status === 200) {
      showToast(`"${file.name}" uploaded successfully! Playing now...`);
    } else {
      showToast("File sharing failed. Server or disk full.");
    }
  };

  xhr.onerror = () => {
    uploadProgressContainer.style.display = 'none';
    inputFileUpload.value = '';
    showToast("Network error occurred during file upload.");
  };

  // Pipe raw binary stream directly across the socket!
  xhr.send(file);
}

function updateUploadedFilesList(files) {
  if (!roomFilesList) return;
  roomFilesList.innerHTML = '';

  if (!files || files.length === 0) {
    roomFilesList.innerHTML = `<div class="empty-folder-message">No files shared yet. Share a local video!</div>`;
    return;
  }

  files.forEach(file => {
    const item = document.createElement('div');
    item.className = 'folder-file-item';
    item.innerHTML = `
      <div class="file-name-container">
        <span class="file-icon">📼</span>
        <span class="file-name-text" title="${file.title}">${file.title}</span>
      </div>
      <div class="file-actions">
        <span class="file-play-badge">Play</span>
        <span class="file-delete-badge" title="Delete from Shared Folder">🗑️</span>
      </div>
    `;

    // Click on name/play badge plays the video
    item.querySelector('.file-name-container').addEventListener('click', () => {
      sendSyncMessage({
        type: 'change-video',
        url: file.url,
        title: file.title
      });
    });

    item.querySelector('.file-play-badge').addEventListener('click', (e) => {
      e.stopPropagation();
      sendSyncMessage({
        type: 'change-video',
        url: file.url,
        title: file.title
      });
    });

    // Click on delete badge deletes the video
    item.querySelector('.file-delete-badge').addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm(`Are you sure you want to delete "${file.title}"?`)) {
        sendSyncMessage({
          type: 'delete-file',
          url: file.url
        });
      }
    });

    roomFilesList.appendChild(item);
  });
}

// 8. Chat Form Handler
chatInputForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;

  sendSyncMessage({
    type: 'chat',
    text: text
  });

  chatInput.value = '';
  chatInput.focus();
});

// 9. WebRTC Voice and Video Calling Core (P2P Mesh + Draggable / Resizable Overlays)
btnToggleCall.addEventListener('click', () => {
  if (!callActive) {
    joinVideoCall();
  } else {
    leaveVideoCall();
  }
});

btnToggleMic.addEventListener('click', () => {
  if (localStream) {
    micEnabled = !micEnabled;
    localStream.getAudioTracks().forEach(track => track.enabled = micEnabled);
    btnToggleMic.classList.toggle('muted', !micEnabled);
    btnToggleMic.innerText = micEnabled ? "🎙️" : "🔇";
    showToast(micEnabled ? "Microphone Unmuted" : "Microphone Muted");
  }
});

btnToggleCam.addEventListener('click', () => {
  if (localStream) {
    camEnabled = !camEnabled;
    localStream.getVideoTracks().forEach(track => track.enabled = camEnabled);
    btnToggleCam.classList.toggle('muted', !camEnabled);
    btnToggleCam.innerText = camEnabled ? "📷" : "🚫";
    
    const localVideo = document.getElementById('video-local');
    if (localVideo) {
      localVideo.style.opacity = camEnabled ? "1" : "0.1";
    }
    showToast(camEnabled ? "Camera Turned On" : "Camera Turned Off");
  }
});

btnHangup.addEventListener('click', () => {
  leaveVideoCall();
});

async function joinVideoCall() {
  try {
    showToast("Requesting camera/microphone access...");
    
    localStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 320 },
        height: { ideal: 320 },
        facingMode: "user"
      },
      audio: true
    });

    callActive = true;
    micEnabled = true;
    camEnabled = true;

    btnToggleMic.classList.remove('muted');
    btnToggleMic.innerText = "🎙️";
    btnToggleCam.classList.remove('muted');
    btnToggleCam.innerText = "📷";

    createLocalVideoCard(localStream);

    sendSyncMessage({ type: 'webrtc-join-call' });

    btnToggleCall.innerText = "📞 Leave Call";
    btnToggleCall.className = "btn btn-sm btn-outline";
    callControlsOverlay.classList.add('show');
    showToast("Joined Video Call! Drag headers & resize corners freely!");
    
  } catch (err) {
    console.error("Camera/Mic access blocked or failed:", err);
    showToast("Call failed: Permission denied or no camera found.");
    callActive = false;
  }
}

function leaveVideoCall() {
  if (!callActive) return;

  sendSyncMessage({ type: 'webrtc-leave-call' });

  callActive = false;

  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }

  for (const userId in peerConnections) {
    peerConnections[userId].close();
    removeRemoteVideoElement(userId);
  }
  peerConnections = {};

  const localCard = document.getElementById('webcam-card-local');
  if (localCard) localCard.remove();

  btnToggleCall.innerText = "📞 Join Call";
  btnToggleCall.className = "btn btn-sm btn-cyan";
  callControlsOverlay.classList.remove('show');
  
  showToast("Left video call.");
}

// Touch/Mouse Dragging Controller
function makeElementDraggable(elmnt, dragHandle) {
  let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;

  dragHandle.onmousedown = dragMouseDown;
  dragHandle.ontouchstart = dragMouseDown;

  function dragMouseDown(e) {
    e = e || window.event;
    
    pos3 = e.clientX || (e.touches && e.touches[0].clientX);
    pos4 = e.clientY || (e.touches && e.touches[0].clientY);
    
    document.onmouseup = closeDragElement;
    document.ontouchend = closeDragElement;
    
    document.onmousemove = elementDrag;
    document.ontouchmove = elementDrag;
  }

  function elementDrag(e) {
    e = e || window.event;
    
    const clientX = e.clientX || (e.touches && e.touches[0].clientX);
    const clientY = e.clientY || (e.touches && e.touches[0].clientY);
    
    pos1 = pos3 - clientX;
    pos2 = pos4 - clientY;
    pos3 = clientX;
    pos4 = clientY;
    
    let newTop = elmnt.offsetTop - pos2;
    let newLeft = elmnt.offsetLeft - pos1;
    
    // Lock cards bounds inside container
    const maxLeft = playerContainer.clientWidth - elmnt.clientWidth;
    const maxTop = playerContainer.clientHeight - elmnt.clientHeight;
    
    if (newLeft < 0) newLeft = 0;
    if (newTop < 0) newTop = 0;
    if (newLeft > maxLeft) newLeft = maxLeft;
    if (newTop > maxTop) newTop = maxTop;
    
    elmnt.style.top = newTop + "px";
    elmnt.style.left = newLeft + "px";
    
    // Clear dynamic alignment anchors
    elmnt.style.bottom = "auto";
    elmnt.style.right = "auto";
  }

  function closeDragElement() {
    document.onmouseup = null;
    document.onmousemove = null;
    document.ontouchend = null;
    document.ontouchmove = null;
  }
}

function createLocalVideoCard(stream) {
  let card = document.getElementById('webcam-card-local');
  if (card) return;

  card = document.createElement('div');
  card.className = 'webcam-card';
  card.id = 'webcam-card-local';

  // Apply default bottom right starting position
  card.style.bottom = "24px";
  card.style.right = "24px";

  // Build the Header window grab handle
  card.innerHTML = `
    <div class="webcam-header" id="local-webcam-header">
      <span class="webcam-drag-icon">⋮⋮</span>
      <span class="webcam-title-name">You</span>
    </div>
    <video id="video-local" autoplay muted playsinline></video>
  `;

  const video = card.querySelector('video');
  video.srcObject = stream;
  
  playerContainer.appendChild(card);
  
  // Drag bound only to header, letting bottom right resizer click pass clean!
  const dragHeader = card.querySelector('.webcam-header');
  makeElementDraggable(card, dragHeader);
}

function createRemoteVideoElement(userId, username, stream) {
  let card = document.getElementById(`webcam-card-${userId}`);
  if (card) {
    const video = card.querySelector('video');
    video.srcObject = stream;
    return;
  }

  card = document.createElement('div');
  card.className = 'webcam-card';
  card.id = `webcam-card-${userId}`;

  const activeWebcamCount = playerContainer.querySelectorAll('.webcam-card').length;
  const rightOffset = 24 + (activeWebcamCount * 146); // staggered offsets
  
  card.style.bottom = "24px";
  card.style.right = `${rightOffset}px`;

  // Build window structure
  card.innerHTML = `
    <div class="webcam-header" id="remote-webcam-header-${userId}">
      <span class="webcam-drag-icon">⋮⋮</span>
      <span class="webcam-title-name">${username}</span>
    </div>
    <video autoplay playsinline></video>
  `;

  const video = card.querySelector('video');
  video.srcObject = stream;
  
  playerContainer.appendChild(card);
  
  const dragHeader = card.querySelector('.webcam-header');
  makeElementDraggable(card, dragHeader);
}

function removeRemoteVideoElement(userId) {
  const card = document.getElementById(`webcam-card-${userId}`);
  if (card) {
    card.remove();
  }
}

// Create an RTCPeerConnection for a target peer
function createPeerConnection(targetUserId, targetUsername) {
  if (peerConnections[targetUserId]) {
    peerConnections[targetUserId].close();
  }

  const pc = new RTCPeerConnection(rtcConfig);
  peerConnections[targetUserId] = pc;

  if (localStream) {
    localStream.getTracks().forEach(track => {
      pc.addTrack(track, localStream);
    });
  }

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendSyncMessage({
        type: 'webrtc-signal',
        targetUserId: targetUserId,
        signal: { type: 'ice-candidate', candidate: event.candidate }
      });
    }
  };

  pc.ontrack = (event) => {
    console.log(`[WebRTC Track] Remote stream arrived from ${targetUsername}`);
    const remoteStream = event.streams[0];
    createRemoteVideoElement(targetUserId, targetUsername, remoteStream);
  };

  pc.onconnectionstatechange = () => {
    console.log(`[WebRTC State] Connection state with ${targetUsername}: ${pc.connectionState}`);
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      removeRemoteVideoElement(targetUserId);
    }
  };

  return pc;
}

// Initiate call by sending Offer signal
async function initiateWebRTCConnection(targetUserId, targetUsername) {
  console.log(`[WebRTC] Initiating P2P call with ${targetUsername} (${targetUserId})`);
  const pc = createPeerConnection(targetUserId, targetUsername);

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    
    sendSyncMessage({
      type: 'webrtc-signal',
      targetUserId: targetUserId,
      signal: { type: 'offer', sdp: pc.localDescription }
    });
  } catch (err) {
    console.error("Failed to generate WebRTC offer:", err);
  }
}

// Handle incoming offers/answers/ICE signals
async function handleIncomingWebRTCSignal(senderUserId, senderUsername, signal) {
  const { type, sdp, candidate } = signal;
  let pc = peerConnections[senderUserId];

  try {
    if (type === 'offer') {
      console.log(`[WebRTC] Received offer from ${senderUsername}`);
      
      pc = createPeerConnection(senderUserId, senderUsername);
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      sendSyncMessage({
        type: 'webrtc-signal',
        targetUserId: senderUserId,
        signal: { type: 'answer', sdp: pc.localDescription }
      });
      
    } else if (type === 'answer') {
      console.log(`[WebRTC] Received answer from ${senderUsername}`);
      if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      }
      
    } else if (type === 'ice-candidate') {
      if (pc) {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      }
    }
  } catch (err) {
    console.error("Failed to process incoming WebRTC signal:", err);
  }
}

// 10. Renderer & Utility Helpers
function updateUsersList(users) {
  userCountBadge.innerText = users.length;
  viewersList.innerHTML = '';
  
  users.forEach(user => {
    const tag = document.createElement('span');
    tag.className = 'user-tag';
    tag.innerText = user.userId === myUserId ? `${user.username} (You)` : user.username;
    tag.setAttribute('data-id', user.userId);
    viewersList.appendChild(tag);
  });
}

function appendNotification(text) {
  const notif = document.createElement('div');
  notif.className = 'chat-notification';
  notif.innerText = text;
  chatMessagesContainer.appendChild(notif);
  chatMessagesContainer.scrollTop = chatMessagesContainer.scrollHeight;
}

function appendChatMessage(username, text, timestamp) {
  const msgDiv = document.createElement('div');
  const isSelf = username === userNickname;
  
  msgDiv.className = `chat-msg ${isSelf ? 'self' : 'other'}`;
  
  msgDiv.innerHTML = `
    <div class="chat-msg-meta">
      <span class="chat-msg-author">${isSelf ? 'You' : username}</span>
      <span class="chat-msg-time">${timestamp}</span>
    </div>
    <div class="chat-msg-text">${escapeHTML(text)}</div>
  `;
  
  chatMessagesContainer.appendChild(msgDiv);
  chatMessagesContainer.scrollTop = chatMessagesContainer.scrollHeight;
}

// Copy sharing invitation link
btnCopyLink.addEventListener('click', () => {
  const roomUrl = `${window.location.protocol}//${window.location.host}/room/${currentRoomId}`;
  
  navigator.clipboard.writeText(roomUrl).then(() => {
    showToast("Shareable Cinema Link copied!");
  }).catch(() => {
    const dummy = document.createElement('input');
    document.body.appendChild(dummy);
    dummy.value = roomUrl;
    dummy.select();
    document.execCommand('copy');
    document.body.removeChild(dummy);
    showToast("Shareable Cinema Link copied!");
  });
});

function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

function escapeHTML(str) {
  return str.replace(/[&<>'"]/g, 
    tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag)
  );
}

// --- Professional Custom Video Player Controller Core ---

// Select custom controls elements
const customTimelineContainer = document.getElementById('timeline-container');
const customBufferedProgress = document.getElementById('buffered-progress');
const customCurrentProgress = document.getElementById('current-progress');
const customPlayhead = document.getElementById('playhead');
const ctrlPlayPauseBtn = document.getElementById('ctrl-play-pause');
const ctrlVolumeBtn = document.getElementById('ctrl-volume');
const ctrlVolumeSlider = document.getElementById('ctrl-volume-slider');
const ctrlCurrentTime = document.getElementById('ctrl-current-time');
const ctrlTotalDuration = document.getElementById('ctrl-total-duration');
const ctrlSpeedBtn = document.getElementById('ctrl-speed-btn');
const ctrlSpeedMenu = document.getElementById('ctrl-speed-menu');
const ctrlFullscreenBtn = document.getElementById('ctrl-fullscreen');
const centerRippleOverlay = document.getElementById('center-ripple-overlay');

// Sync play/pause icons inside our controls
function updateCustomPlayPauseUI(isPlaying) {
  if (!ctrlPlayPauseBtn) return;
  const playIcon = ctrlPlayPauseBtn.querySelector('.play-icon');
  const pauseIcon = ctrlPlayPauseBtn.querySelector('.pause-icon');
  if (isPlaying) {
    if (playIcon) playIcon.style.display = 'none';
    if (pauseIcon) pauseIcon.style.display = 'block';
  } else {
    if (playIcon) playIcon.style.display = 'block';
    if (pauseIcon) pauseIcon.style.display = 'none';
  }
}

// Volume icon dynamic levels based on active volume
function updateVolumeIconUI() {
  if (!ctrlVolumeBtn) return;
  const volHigh = ctrlVolumeBtn.querySelector('.vol-high-icon');
  const volMute = ctrlVolumeBtn.querySelector('.vol-mute-icon');
  
  if (sharedVideo.muted || sharedVideo.volume === 0) {
    if (volHigh) volHigh.style.display = 'none';
    if (volMute) volMute.style.display = 'block';
  } else {
    if (volHigh) volHigh.style.display = 'block';
    if (volMute) volMute.style.display = 'none';
  }
}

// Center splash ripple splash animation
function triggerPlayPauseRipple(isPlaying) {
  if (!centerRippleOverlay) return;
  const playSvg = centerRippleOverlay.querySelector('.ripple-play');
  const pauseSvg = centerRippleOverlay.querySelector('.ripple-pause');
  
  if (isPlaying) {
    if (playSvg) playSvg.style.display = 'block';
    if (pauseSvg) pauseSvg.style.display = 'none';
  } else {
    if (playSvg) playSvg.style.display = 'none';
    if (pauseSvg) pauseSvg.style.display = 'block';
  }
  
  centerRippleOverlay.classList.remove('ripple-active');
  void centerRippleOverlay.offsetWidth; // Force CSS repaint
  centerRippleOverlay.classList.add('ripple-active');
}

// Update scrubber progress timeline in real-time
sharedVideo.addEventListener('timeupdate', () => {
  if (currentPlayerMode !== 'html5' || !sharedVideo.duration) return;
  
  const percentage = (sharedVideo.currentTime / sharedVideo.duration) * 100;
  if (customCurrentProgress) customCurrentProgress.style.width = `${percentage}%`;
  if (customPlayhead) customPlayhead.style.left = `${percentage}%`;
  
  if (ctrlCurrentTime) ctrlCurrentTime.innerText = formatDuration(sharedVideo.currentTime);
});

// Update buffered loading segments progress
sharedVideo.addEventListener('progress', () => {
  if (currentPlayerMode !== 'html5' || !sharedVideo.duration || sharedVideo.buffered.length === 0) return;
  
  const bufferedEnd = sharedVideo.buffered.end(sharedVideo.buffered.length - 1);
  const percentage = (bufferedEnd / sharedVideo.duration) * 100;
  if (customBufferedProgress) customBufferedProgress.style.width = `${percentage}%`;
});

// Setup duration metadata when loaded
sharedVideo.addEventListener('loadedmetadata', () => {
  if (ctrlTotalDuration) ctrlTotalDuration.innerText = formatDuration(sharedVideo.duration);
});

// Hook custom play/pause button action
if (ctrlPlayPauseBtn) {
  ctrlPlayPauseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (currentPlayerMode !== 'html5') return;
    
    if (sharedVideo.paused) {
      sharedVideo.play();
    } else {
      sharedVideo.pause();
    }
  });
}

// Custom Timeline Scrubber seek click tracking
if (customTimelineContainer) {
  customTimelineContainer.addEventListener('click', (e) => {
    if (currentPlayerMode !== 'html5' || !sharedVideo.duration) return;
    
    const rect = customTimelineContainer.getBoundingClientRect();
    const pos = (e.clientX - rect.left) / rect.width;
    const targetTime = pos * sharedVideo.duration;
    
    sharedVideo.currentTime = targetTime;
    sendSyncMessage({
      type: 'seek',
      time: targetTime
    });
  });
}

// Volume Mute Button click toggle
if (ctrlVolumeBtn) {
  ctrlVolumeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    sharedVideo.muted = !sharedVideo.muted;
    updateVolumeIconUI();
    if (sharedVideo.muted) {
      if (ctrlVolumeSlider) ctrlVolumeSlider.value = 0;
    } else {
      if (ctrlVolumeSlider) ctrlVolumeSlider.value = sharedVideo.volume;
    }
  });
}

// Volume Slider input tracking
if (ctrlVolumeSlider) {
  ctrlVolumeSlider.addEventListener('input', () => {
    sharedVideo.volume = parseFloat(ctrlVolumeSlider.value);
    sharedVideo.muted = (sharedVideo.volume === 0);
    updateVolumeIconUI();
  });
}

// Playback Speed Selector toggle popup
if (ctrlSpeedBtn) {
  ctrlSpeedBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (ctrlSpeedMenu) ctrlSpeedMenu.classList.toggle('show');
  });
}

// Hide Speed menu dropdown on clicking elsewhere on page
document.addEventListener('click', () => {
  if (ctrlSpeedMenu) ctrlSpeedMenu.classList.remove('show');
});

// Hook up Speed menu options click
if (ctrlSpeedMenu) {
  ctrlSpeedMenu.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    
    const speed = parseFloat(btn.getAttribute('data-speed'));
    sharedVideo.playbackRate = speed;
    if (ctrlSpeedBtn) ctrlSpeedBtn.innerText = `${speed.toFixed(2)}x`;
    
    ctrlSpeedMenu.querySelectorAll('button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
}

// Fullscreen button triggers prefix-friendly Cinema Fullscreen
if (ctrlFullscreenBtn) {
  ctrlFullscreenBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleCinemaFullscreen();
  });
}

// Center body clicking on the player container itself triggers play/pause + splash ripple
sharedVideo.addEventListener('click', (e) => {
  e.preventDefault();
  if (currentPlayerMode !== 'html5') return;
  
  if (sharedVideo.paused) {
    sharedVideo.play();
  } else {
    sharedVideo.pause();
  }
});

// Format duration helper to properly handle hours/minutes/seconds
function formatDuration(seconds) {
  if (isNaN(seconds) || seconds === Infinity) return "0:00";
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hrs > 0) {
    return `${hrs}:${mins < 10 ? '0' : ''}${mins}:${secs < 10 ? '0' : ''}${secs}`;
  }
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

// Spacebar play/pause key handler
window.addEventListener('keydown', (e) => {
  if (e.code === "Space") {
    if (document.activeElement.tagName === "INPUT" || document.activeElement.tagName === "TEXTAREA") {
      return;
    }
    e.preventDefault();
    if (currentPlayerMode === 'html5') {
      if (sharedVideo.paused) {
        sharedVideo.play();
      } else {
        sharedVideo.pause();
      }
    }
  }
});
