/**
 * The TV in the scene: a muted YouTube player that shows the song's video
 * while the fly plays it. The sound always comes from the fly's own take.
 */

export function parseYouTubeId(input) {
  const raw = String(input || '').trim();
  let id = null;
  if (/^[\w-]{11}$/.test(raw)) id = raw;
  else
    try {
      const u = new URL(raw);
      if (u.hostname.includes('youtu.be')) id = u.pathname.split('/').filter(Boolean)[0] || null;
      else if (u.searchParams.get('v')) id = u.searchParams.get('v');
      else {
        const embed = u.pathname.match(/\/(?:embed|shorts)\/([^/?]+)/);
        if (embed) id = embed[1];
      }
    } catch {
      /* not a URL */
    }
  return /^[\w-]{11}$/.test(id || '') ? id : null;
}

function loadYouTubeApi() {
  if (globalThis.YT?.Player) return Promise.resolve();
  if (loadYouTubeApi.pending) return loadYouTubeApi.pending;
  loadYouTubeApi.pending = new Promise((resolve, reject) => {
    const prev = globalThis.onYouTubeIframeAPIReady;
    globalThis.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve();
    };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.onerror = () => {
      loadYouTubeApi.pending = null;
      reject(Error('YouTube API failed to load'));
    };
    document.head.appendChild(script);
  });
  return loadYouTubeApi.pending;
}

export class YouTubeTV {
  constructor() {
    this.player = null;
    this.ready = false;
    // What the TV should be doing once the player is ready: { at, playing }.
    this.wanted = null;
  }

  async load(videoId) {
    await loadYouTubeApi();
    const frame = document.getElementById('yt-tv-frame');
    if (!frame || !globalThis.YT?.Player) throw Error('YouTube TV is not ready');
    if (this.player) {
      this.player.cueVideoById(videoId);
      this.player.mute();
      this._apply();
      return;
    }
    this.ready = false;
    this.player = new globalThis.YT.Player(frame, {
      videoId,
      width: 640,
      height: 360,
      playerVars: {
        enablejsapi: 1,
        origin: window.location.origin,
        rel: 0,
        modestbranding: 1,
        playsinline: 1,
        controls: 0,
        fs: 0,
      },
      events: {
        onReady: (e) => {
          this.ready = true;
          e.target.mute();
          this._apply();
        },
      },
    });
  }

  _apply() {
    if (!this.ready || !this.wanted) return;
    const { at, playing } = this.wanted;
    this.player.seekTo(at, true);
    if (playing) this.player.playVideo();
    else this.player.pauseVideo();
  }

  play(atSec) {
    this.wanted = { at: atSec, playing: true };
    this._apply();
  }

  pause() {
    if (this.wanted) this.wanted.playing = false;
    if (this.ready) this.player.pauseVideo();
  }

  /** Show the frame at `atSec` without playing. */
  seek(atSec) {
    this.wanted = { at: atSec, playing: false };
    this._apply();
  }

  /** Nudge the video back in line with the song if it has drifted. */
  sync(songSec) {
    if (!this.ready || !this.wanted?.playing) return;
    const t = this.player.getCurrentTime?.();
    if (Number.isFinite(t) && Math.abs(t - songSec) > 0.35) this.player.seekTo(songSec, true);
  }
}
