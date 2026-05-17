import { join } from "path";

// Define Types for our synchronization and WebRTC calling state
interface User {
  userId: string;
  username: string;
  ws: any;
  isBuffering: boolean; // Coordinated Auto-Pause / Auto-Resume
}

interface UploadedFile {
  url: string;
  title: string;
}

interface Room {
  id: string;
  users: User[];
  videoUrl: string;
  videoTitle: string;
  isPlaying: boolean;
  currentTime: number;
  lastSyncTime: number;
  uploadedFiles: UploadedFile[];
  isPausedForBuffering: boolean; // Protects from redundant Auto-Resume loops!
}

interface WebSocketData {
  roomId: string;
  username: string;
  userId: string;
}

// Global In-Memory Rooms State
const rooms = new Map<string, Room>();

const PUBLIC_DIR = join(import.meta.dir, "public");

// Dynamic MIME type mapping to guarantee perfect media parsing in macOS Safari & Chrome!
function getMimeType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'mp4': return 'video/mp4';
    case 'm4v': return 'video/mp4';
    case 'mov': return 'video/quicktime';
    case 'webm': return 'video/webm';
    case 'ogg': return 'video/ogg';
    case 'ogv': return 'video/ogg';
    case 'mp3': return 'audio/mpeg';
    case 'wav': return 'audio/wav';
    case 'css': return 'text/css';
    case 'js': return 'application/javascript';
    case 'html': return 'text/html';
    default: return 'application/octet-stream';
  }
}

// Helper to sync uploaded files dynamically from server disk storage
function syncUploadedFilesForRoom(roomId: string): UploadedFile[] {
  const fs = require("fs");
  const roomUploadsDir = join(PUBLIC_DIR, "uploads", roomId);
  if (!fs.existsSync(roomUploadsDir)) {
    return [];
  }
  try {
    const files = fs.readdirSync(roomUploadsDir);
    return files
      .filter((f: string) => !f.startsWith('.'))
      .map((f: string) => ({
        url: `/uploads/${roomId}/${f}`,
        title: f.replace(/_/g, " ")
      }));
  } catch (err) {
    console.error("Error reading room uploads dir:", err);
    return [];
  }
}

// Helper to broadcast JSON messages to all users in a room
function broadcastToRoom(roomId: string, message: any, excludeUserId?: string) {
  const room = rooms.get(roomId);
  if (!room) return;

  const msgString = JSON.stringify(message);
  for (const user of room.users) {
    if (user.userId !== excludeUserId) {
      try {
        user.ws.send(msgString);
      } catch (err) {
        console.error(`Failed to send to user ${user.username}:`, err);
      }
    }
  }
}

// Serve HTTP requests and establish WebSocket connections
const server = Bun.serve<WebSocketData>({
  port: parseInt(process.env.PORT || "54321", 10),
  // Configure Bun server to accept large video shares (up to 10 Gigabytes!)
  maxRequestBodySize: 1024 * 1024 * 1024 * 10, 
  
  async fetch(req, server) {
    const url = new URL(req.url);

    // Handle WebSocket endpoint
    if (url.pathname === "/ws") {
      const roomId = url.searchParams.get("roomId");
      const username = url.searchParams.get("username") || "Guest";

      if (!roomId) {
        return new Response("Missing roomId parameter", { status: 400 });
      }

      const upgraded = server.upgrade(req, {
        data: {
          roomId,
          username,
          userId: Math.random().toString(36).substring(2, 9),
        },
      });

      if (upgraded) {
        return undefined; // Handled by WS upgrade
      }
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // Handle File Upload API (Direct Binary chunk-by-chunk streaming to support large files!)
    if (url.pathname === "/api/upload" && req.method === "POST") {
      try {
        const roomId = req.headers.get("x-room-id");
        const username = decodeURIComponent(req.headers.get("x-username") || "User");
        const filename = decodeURIComponent(req.headers.get("x-filename") || "video.mp4");

        if (!roomId || !filename) {
          return new Response(JSON.stringify({ error: "Missing x-room-id or x-filename headers" }), {
            status: 400,
            headers: { "Content-Type": "application/json" }
          });
        }

        const fs = require("fs/promises");
        const roomUploadsDir = join(PUBLIC_DIR, "uploads", roomId);
        await fs.mkdir(roomUploadsDir, { recursive: true });

        const safeName = filename.replace(/[^a-zA-Z0-9.\-_]/g, "_");
        const filePath = join(roomUploadsDir, safeName);

        // Pipe request body stream directly to disk chunk-by-chunk (low memory!)
        if (req.body) {
          const writer = Bun.file(filePath).writer();
          const reader = req.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            writer.write(value);
          }
          writer.end();
        } else {
          return new Response(JSON.stringify({ error: "Empty request body" }), {
            status: 400,
            headers: { "Content-Type": "application/json" }
          });
        }

        const fileUrl = `/uploads/${roomId}/${safeName}`;
        const room = rooms.get(roomId);

        if (room) {
          const fileEntry = { url: fileUrl, title: filename };
          if (!room.uploadedFiles.some(f => f.url === fileUrl)) {
            room.uploadedFiles.push(fileEntry);
          }

          // System message notification
          broadcastToRoom(roomId, {
            type: "chat",
            username: "System",
            text: `📁 New local video shared: "${filename}"! Available in Room Shared Folder.`,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          });

          // Broadcast updated files list
          broadcastToRoom(roomId, {
            type: "uploaded-files-update",
            files: room.uploadedFiles
          });

          // Auto-play the uploaded video immediately for everyone
          room.videoUrl = fileUrl;
          room.videoTitle = filename;
          room.isPlaying = false;
          room.currentTime = 0;
          room.lastSyncTime = Date.now();
          room.isPausedForBuffering = false;

          // Clear buffer states on new video load
          room.users.forEach(u => u.isBuffering = false);
          broadcastToRoom(roomId, {
            type: "buffering-state",
            isBuffering: false
          });

          broadcastToRoom(roomId, {
            type: "change-video",
            username: username || "User",
            url: fileUrl,
            title: filename
          });
        }

        return new Response(JSON.stringify({ success: true, url: fileUrl }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (err: any) {
        console.error("Upload error:", err);
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    // Static assets file serving
    if (url.pathname === "/" || url.pathname.startsWith("/room/")) {
      const file = Bun.file(join(PUBLIC_DIR, "index.html"));
      if (await file.exists()) {
        return new Response(file);
      }
    }

    if (url.pathname === "/style.css") {
      const file = Bun.file(join(PUBLIC_DIR, "style.css"));
      if (await file.exists()) {
        return new Response(file, { headers: { "Content-Type": "text/css" } });
      }
    }

    if (url.pathname === "/client.js") {
      const file = Bun.file(join(PUBLIC_DIR, "client.js"));
      if (await file.exists()) {
        return new Response(file, { headers: { "Content-Type": "application/javascript" } });
      }
    }

    // Fallback static resource handler (With Full HTTP Range 206 Partial Content Streaming Support!)
    const safePath = join(PUBLIC_DIR, url.pathname.replace(/\.\./g, ""));
    const file = Bun.file(safePath);
    
    if (await file.exists()) {
      const fileSize = file.size;
      const range = req.headers.get("range");
      const contentType = getMimeType(safePath);

      if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

        if (start >= fileSize || end >= fileSize) {
          return new Response("Range Not Satisfiable", {
            status: 416,
            headers: {
              "Content-Range": `bytes */${fileSize}`
            }
          });
        }

        const chunkSize = (end - start) + 1;
        const fileSlice = file.slice(start, end + 1);

        return new Response(fileSlice, {
          status: 206,
          headers: {
            "Content-Range": `bytes ${start}-${end}/${fileSize}`,
            "Accept-Ranges": "bytes",
            "Content-Length": chunkSize.toString(),
            "Content-Type": contentType
          }
        });
      }

      // No range requested, serve complete file with range metadata declared
      return new Response(file, {
        headers: {
          "Accept-Ranges": "bytes",
          "Content-Length": fileSize.toString(),
          "Content-Type": contentType
        }
      });
    }

    return new Response("Not Found", { status: 404 });
  },

  websocket: {
    // When a user successfully upgrades to WS and joins
    open(ws) {
      const { roomId, username, userId } = ws.data;

      // If room doesn't exist, create it with a cool default video trailer
      if (!rooms.has(roomId)) {
        rooms.set(roomId, {
          id: roomId,
          users: [],
          videoUrl: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4",
          videoTitle: "Sintel (Open Movie Project)",
          isPlaying: false,
          currentTime: 0,
          lastSyncTime: Date.now(),
          uploadedFiles: [],
          isPausedForBuffering: false
        });
        console.log(`[Room Created] Room ID: ${roomId}`);
      }

      const room = rooms.get(roomId)!;

      // Dynamically load any previously uploaded files on disk
      room.uploadedFiles = syncUploadedFilesForRoom(roomId);

      // Auto-load last uploaded file if room currently has default video URL
      if (room.uploadedFiles.length > 0 && room.videoUrl === "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4") {
        const latestFile = room.uploadedFiles[room.uploadedFiles.length - 1];
        room.videoUrl = latestFile.url;
        room.videoTitle = latestFile.title;
      }

      room.users.push({ userId, username, ws, isBuffering: false });

      console.log(`[User Joined] ${username} (ID: ${userId}) joined Room: ${roomId}`);

      const userList = room.users.map(u => ({ userId: u.userId, username: u.username }));

      // Notify others in the room
      broadcastToRoom(roomId, {
        type: "user-joined",
        username,
        userId,
        users: userList
      }, userId);

      // Send the current room playing state & user list to the newcomer
      ws.send(JSON.stringify({
        type: "room-state",
        userId,
        users: userList,
        videoUrl: room.videoUrl,
        videoTitle: room.videoTitle,
        isPlaying: room.isPlaying,
        currentTime: room.currentTime,
        lastSyncTime: room.lastSyncTime,
        uploadedFiles: room.uploadedFiles
      }));
    },

    // When the server receives a message from a user
    message(ws, rawMessage) {
      try {
        const messageString = typeof rawMessage === "string" ? rawMessage : new TextDecoder().decode(rawMessage);
        const data = JSON.parse(messageString);
        const { roomId, userId, username } = ws.data;

        const room = rooms.get(roomId);
        if (!room) return;

        switch (data.type) {
          // Playback Synchronization Handlers
          case "play":
            room.isPlaying = true;
            room.currentTime = data.time;
            room.lastSyncTime = Date.now();
            room.isPausedForBuffering = false; // Manual play overrides buffer suspensions
            
            // Instantly clear buffer states and dismiss overlays on manual override!
            room.users.forEach(u => u.isBuffering = false);
            broadcastToRoom(roomId, {
              type: "buffering-state",
              isBuffering: false
            });

            console.log(`[Play Sync] Room ${roomId} - Play at ${data.time}s requested by ${username}`);
            broadcastToRoom(roomId, {
              type: "play",
              username,
              time: data.time
            }, userId);
            break;

          case "pause":
            room.isPlaying = false;
            room.currentTime = data.time;
            room.lastSyncTime = Date.now();
            room.isPausedForBuffering = false; // Manual pause overrides buffer suspensions
            
            // Instantly clear buffer states and dismiss overlays on manual override!
            room.users.forEach(u => u.isBuffering = false);
            broadcastToRoom(roomId, {
              type: "buffering-state",
              isBuffering: false
            });

            console.log(`[Pause Sync] Room ${roomId} - Pause at ${data.time}s requested by ${username}`);
            broadcastToRoom(roomId, {
              type: "pause",
              username,
              time: data.time
            }, userId);
            break;

          case "seek":
            room.currentTime = data.time;
            room.lastSyncTime = Date.now();
            console.log(`[Seek Sync] Room ${roomId} - Seek to ${data.time}s requested by ${username}`);
            broadcastToRoom(roomId, {
              type: "seek",
              username,
              time: data.time
            }, userId);
            break;

          case "change-video":
            room.videoUrl = data.url;
            room.videoTitle = data.title || "External Video Source";
            room.isPlaying = false;
            room.currentTime = 0;
            room.lastSyncTime = Date.now();
            room.isPausedForBuffering = false;

            // Clear buffer states on new video load
            room.users.forEach(u => u.isBuffering = false);
            broadcastToRoom(roomId, {
              type: "buffering-state",
              isBuffering: false
            });

            console.log(`[Video Change] Room ${roomId} - Loaded: ${room.videoTitle} (${data.url}) by ${username}`);
            
            broadcastToRoom(roomId, {
              type: "change-video",
              username,
              url: data.url,
              title: room.videoTitle
            });
            break;

          // Coordinated Buffer Synchronization Endpoints
          case "buffering":
            const userBuf = room.users.find(u => u.userId === userId);
            if (userBuf) {
              userBuf.isBuffering = true;
            }
            console.log(`[Coordinated Buffering] User ${username} is buffering in Room ${roomId}`);
            
            // Mark the room as suspended for buffering
            room.isPausedForBuffering = true;

            // Show wait loading modal on all room peer viewports
            broadcastToRoom(roomId, {
              type: "buffering-state",
              username,
              isBuffering: true
            });

            // Trigger safe sync auto-pause on all screens
            if (room.isPlaying) {
              room.isPlaying = false;
              room.lastSyncTime = Date.now();
              broadcastToRoom(roomId, {
                type: "pause",
                username: `${username} (Buffering)`,
                time: room.currentTime
              });
            }
            break;

          case "buffered-ready":
            const userReady = room.users.find(u => u.userId === userId);
            if (userReady) {
              userReady.isBuffering = false;
            }
            
            // Prevent auto-resume loops unless room is actively suspended for buffering!
            if (!room.isPausedForBuffering) {
              return;
            }

            console.log(`[Coordinated Ready] User ${username} buffering completed in Room ${roomId}`);

            // Inspect if all peers are finished buffering
            const allReady = room.users.every(u => !u.isBuffering);
            if (allReady) {
              console.log(`[Coordinated Resume] All users ready in Room ${roomId}. Resuming!`);
              
              // Clear buffering suspended state
              room.isPausedForBuffering = false;

              // Direct all clients to hide buffering overlays
              broadcastToRoom(roomId, {
                type: "buffering-state",
                isBuffering: false
              });

              // Trigger dynamic sync play/resume command
              room.isPlaying = true;
              room.lastSyncTime = Date.now();
              broadcastToRoom(roomId, {
                type: "play",
                username: "System (Auto-Resume)",
                time: room.currentTime
              });
            }
            break;

          case "chat":
            const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            console.log(`[Chat Message] Room ${roomId} - ${username}: ${data.text}`);
            broadcastToRoom(roomId, {
              type: "chat",
              username,
              text: data.text,
              timestamp
            });
            break;

          case "delete-file":
            try {
              const fs = require("fs");
              const relativePath = data.url.replace(/^\//, "");
              const filePath = join(PUBLIC_DIR, relativePath);
              if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                console.log(`[File Deleted] Deleted file: ${filePath}`);
              }

              // Re-sync uploaded files list from disk
              room.uploadedFiles = syncUploadedFilesForRoom(roomId);

              // Broadcast updated files list to all room members
              broadcastToRoom(roomId, {
                type: "uploaded-files-update",
                files: room.uploadedFiles
              });

              // Notification in chat
              const filename = data.url.split('/').pop() || "Video";
              broadcastToRoom(roomId, {
                type: "chat",
                username: "System",
                text: `🗑️ Video deleted from room folder: "${filename.replace(/_/g, " ")}"`,
                timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
              });

              // If the deleted file was the one currently playing, reset room video to default!
              if (room.videoUrl === data.url) {
                room.videoUrl = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4";
                room.videoTitle = "Sintel (Open Movie Project)";
                room.isPlaying = false;
                room.currentTime = 0;
                room.lastSyncTime = Date.now();
                room.isPausedForBuffering = false;

                broadcastToRoom(roomId, {
                  type: "change-video",
                  username: "System",
                  url: room.videoUrl,
                  title: room.videoTitle
                });
              }
            } catch (err) {
              console.error("Failed to delete file:", err);
            }
            break;

          case "request-sync":
            ws.send(JSON.stringify({
              type: "room-state",
              userId,
              users: room.users.map(u => ({ userId: u.userId, username: u.username })),
              videoUrl: room.videoUrl,
              videoTitle: room.videoTitle,
              isPlaying: room.isPlaying,
              currentTime: room.currentTime,
              lastSyncTime: room.lastSyncTime,
              uploadedFiles: room.uploadedFiles
            }));
            break;

          // P2P WebRTC Signaling Proxy Handlers
          case "webrtc-signal":
            const targetUser = room.users.find(u => u.userId === data.targetUserId);
            if (targetUser) {
              targetUser.ws.send(JSON.stringify({
                type: "webrtc-signal",
                senderUserId: userId,
                senderUsername: username,
                signal: data.signal
              }));
            }
            break;

          case "webrtc-join-call":
            console.log(`[WebRTC Call Join] ${username} joined video call in room ${roomId}`);
            broadcastToRoom(roomId, {
              type: "webrtc-joined-call",
              userId,
              username
            }, userId);
            break;

          case "webrtc-leave-call":
            console.log(`[WebRTC Call Leave] ${username} left video call in room ${roomId}`);
            broadcastToRoom(roomId, {
              type: "webrtc-left-call",
              userId,
              username
            }, userId);
            break;
        }
      } catch (err) {
        console.error("Error processing websocket message:", err);
      }
    },

    // When a user disconnects
    close(ws, code, reason) {
      const { roomId, userId, username } = ws.data;
      const room = rooms.get(roomId);
      if (!room) return;

      // Remove user
      room.users = room.users.filter(u => u.userId !== userId);
      console.log(`[User Left] ${username} left Room: ${roomId} (Remaining: ${room.users.length})`);

      if (room.users.length === 0) {
        // Clean up empty rooms to prevent memory leaks
        rooms.delete(roomId);
        console.log(`[Room Deleted] Room ID: ${roomId} (no active users)`);
      } else {
        const userList = room.users.map(u => ({ userId: u.userId, username: u.username }));
        // Inform other members
        broadcastToRoom(roomId, {
          type: "user-left",
          username,
          userId,
          users: userList
        });

        // If the lagging buffering user left, check if we can resume the remaining peers immediately!
        if (room.isPausedForBuffering) {
          const allReady = room.users.every(u => !u.isBuffering);
          if (allReady) {
            room.isPausedForBuffering = false;
            broadcastToRoom(roomId, {
              type: "buffering-state",
              isBuffering: false
            });
            room.isPlaying = true;
            room.lastSyncTime = Date.now();
            broadcastToRoom(roomId, {
              type: "play",
              username: "System (Auto-Resume)",
              time: room.currentTime
            });
          }
        }
      }
    }
  }
});

console.log(`🎬 SyncCinema Server is running beautifully on http://localhost:${server.port}`);
