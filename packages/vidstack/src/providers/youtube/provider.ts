import { createScope, effect, peek, signal } from 'maverick.js';
import { isBoolean, isNumber, isObject, isString, type DeferredPromise } from 'maverick.js/std';

import { TimeRange, type MediaSrc } from '../../core';
import { preconnect } from '../../utils/network';
import { timedPromise } from '../../utils/promise';
import { EmbedProvider } from '../embed/EmbedProvider';
import type { MediaProviderAdapter, MediaSetupContext } from '../types';
import type { YouTubeCommandArg } from './embed/command';
import type { YouTubeMessage } from './embed/message';
import type { YouTubeParams } from './embed/params';
import { YouTubePlayerState, type YouTubePlayerStateValue } from './embed/state';

/**
 * This provider enables loading videos uploaded to YouTube (youtube.com) via embeds.
 *
 * @docs {@link https://www.vidstack.io/docs/player/providers/youtube}
 * @see {@link https://developers.google.com/youtube/iframe_api_reference}
 * @example
 * ```html
 * <media-player src="youtube/_cMxraX_5RE">
 *   <media-provider></media-provider>
 * </media-player>
 * ```
 */
export class YouTubeProvider
  extends EmbedProvider<YouTubeMessage>
  implements MediaProviderAdapter, Pick<YouTubeParams, 'color' | 'start' | 'end' | 'rel'>
{
  protected readonly $$PROVIDER_TYPE = 'YOUTUBE';

  protected static _videoIdRE =
    /(?:youtu\.be|youtube|youtube\.com|youtube-nocookie\.com)\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|)((?:\w|-){11})/;
  protected static _posterCache = new Map<string, string>();

  readonly scope = createScope();

  protected _ctx!: MediaSetupContext;
  protected _videoId = signal('');
  protected _state: YouTubePlayerStateValue = -1;
  protected _seekingTimer = -1;
  protected _played = 0;
  protected _playedRange = new TimeRange(0, 0);
  protected _currentSrc: MediaSrc<string> | null = null;
  protected _playPromise: DeferredPromise<void, string> | null = null;
  protected _pausePromise: DeferredPromise<void, string> | null = null;

  protected get _notify() {
    return this._ctx.delegate._notify;
  }

  /**
   * Sets the player's interface language. The parameter value is an ISO 639-1 two-letter
   * language code or a fully specified locale. For example, fr and fr-ca are both valid values.
   * Other language input codes, such as IETF language tags (BCP 47) might also be handled properly.
   *
   * The interface language is used for tooltips in the player and also affects the default caption
   * track. Note that YouTube might select a different caption track language for a particular
   * user based on the user's individual language preferences and the availability of caption tracks.
   *
   * @defaultValue 'en'
   */
  language = 'en';
  color: 'white' | 'red' = 'red';

  /**
   * Whether cookies should be enabled on the embed. This is turned off by default to be
   * GDPR-compliant.
   *
   * @defaultValue `false`
   */
  cookies = false;

  get currentSrc(): MediaSrc<string> | null {
    return this._currentSrc;
  }

  get type() {
    return 'youtube';
  }

  get videoId() {
    return this._videoId();
  }

  preconnect() {
    const connections = [
      this._getOrigin(),
      // Botguard script.
      'https://www.google.com',
      // Poster.
      'https://i.ytimg.com',
      // Ads.
      'https://googleads.g.doubleclick.net',
      'https://static.doubleclick.net',
    ];

    for (const url of connections) {
      preconnect(url, 'preconnect');
    }
  }

  override setup(ctx: MediaSetupContext) {
    this._ctx = ctx;
    super.setup(ctx);
    effect(this._watchVideoId.bind(this));
    effect(this._watchPoster.bind(this));
    this._notify('provider-setup', this);
  }

  async play() {
    const { paused } = this._ctx.$state;
    if (!peek(paused)) return;

    if (!this._playPromise) {
      this._playPromise = timedPromise<void, string>(() => {
        this._playPromise = null;
        if (paused()) return 'Timed out.';
      });

      this._remote('playVideo');
    }

    return this._playPromise.promise;
  }

  async pause() {
    const { paused } = this._ctx.$state;
    if (peek(paused)) return;

    if (!this._pausePromise) {
      this._pausePromise = timedPromise<void, string>(() => {
        this._pausePromise = null;
        if (!paused()) 'Timed out.';
      });

      this._remote('pauseVideo');
    }

    return this._pausePromise.promise;
  }

  setMuted(muted: boolean) {
    if (muted) this._remote('mute');
    else this._remote('unMute');
  }

  setCurrentTime(time: number) {
    this._remote('seekTo', time);
  }

  setVolume(volume: number) {
    this._remote('setVolume', volume * 100);
  }

  setPlaybackRate(rate: number) {
    this._remote('setPlaybackRate', rate);
  }

  async loadSource(src: MediaSrc) {
    if (!isString(src.src)) {
      this._currentSrc = null;
      this._videoId.set('');
      return;
    }

    const videoId = src.src.match(YouTubeProvider._videoIdRE)?.[1];
    this._videoId.set(videoId ?? '');

    this._currentSrc = src as MediaSrc<string>;
  }

  protected override _getOrigin() {
    return !this.cookies ? 'https://www.youtube-nocookie.com' : 'https://www.youtube.com';
  }

  protected _watchVideoId() {
    this._reset();

    const videoId = this._videoId();

    if (!videoId) {
      this._src.set('');
      return;
    }

    this._src.set(`${this._getOrigin()}/embed/${videoId}`);
  }

  protected _watchPoster() {
    const videoId = this._videoId(),
      cache = YouTubeProvider._posterCache;

    if (!videoId) return;

    if (cache.has(videoId)) {
      const url = cache.get(videoId)!;
      this._notify('poster-change', url);
      return;
    }

    const abort = new AbortController();
    this._findPoster(videoId, abort);

    return () => {
      abort.abort();
    };
  }

  private async _findPoster(videoId: string, abort: AbortController) {
    try {
      const sizes = ['maxresdefault', 'sddefault', 'hqdefault'];
      for (const size of sizes) {
        for (const webp of [true, false]) {
          const url = this._resolvePosterURL(videoId, size, webp),
            response = await fetch(url, {
              mode: 'no-cors',
              signal: abort.signal,
            });

          if (response.status < 400) {
            YouTubeProvider._posterCache.set(videoId, url);
            this._notify('poster-change', url);
            return;
          }
        }
      }
    } catch (e) {
      // no-op
    }

    this._notify('poster-change', '');
  }

  protected _resolvePosterURL(videoId: string, size: string, webp: boolean) {
    const type = webp ? 'webp' : 'jpg';
    return `https://i.ytimg.com/${webp ? 'vi_webp' : 'vi'}/${videoId}/${size}.${type}`;
  }

  protected override _buildParams(): YouTubeParams {
    const { keyDisabled } = this._ctx.$props,
      { $iosControls } = this._ctx,
      { controls, muted, playsinline } = this._ctx.$state,
      showControls = controls() || $iosControls();
    return {
      autoplay: 0,
      cc_lang_pref: this.language,
      cc_load_policy: showControls ? 1 : undefined,
      color: this.color,
      controls: showControls ? 1 : 0,
      disablekb: !showControls || keyDisabled() ? 1 : 0,
      enablejsapi: 1,
      fs: 1,
      hl: this.language,
      iv_load_policy: showControls ? 1 : 3,
      mute: muted() ? 1 : 0,
      playsinline: playsinline() ? 1 : 0,
    };
  }

  protected _remote<T extends keyof YouTubeCommandArg>(command: T, arg?: YouTubeCommandArg[T]) {
    this._postMessage({
      event: 'command',
      func: command,
      args: arg ? [arg] : undefined,
    });
  }

  protected override _onLoad(): void {
    // Seems like we have to wait a random small delay or else YT player isn't ready.
    window.setTimeout(() => this._postMessage({ event: 'listening' }), 100);
  }

  protected _onReady(trigger: Event) {
    this._ctx.delegate._ready(undefined, trigger);
  }

  protected _onPause(trigger: Event) {
    this._pausePromise?.resolve();
    this._pausePromise = null;
    this._notify('pause', undefined, trigger);
  }

  protected _onTimeUpdate(time: number, trigger: Event) {
    const { duration, currentTime } = this._ctx.$state,
      boundTime = this._state === YouTubePlayerState._Ended ? duration() : time,
      detail = {
        currentTime: boundTime,
        played:
          this._played >= boundTime
            ? this._playedRange
            : (this._playedRange = new TimeRange(0, (this._played = time))),
      };

    this._notify('time-update', detail, trigger);

    // // This is the only way to detect `seeking`.
    if (Math.abs(boundTime - currentTime()) > 1) {
      this._notify('seeking', boundTime, trigger);
    }
  }

  protected _onProgress(buffered: number, seekable: TimeRange, trigger: Event) {
    const detail = {
      buffered: new TimeRange(0, buffered),
      seekable,
    };

    this._notify('progress', detail, trigger);

    const { seeking, currentTime } = this._ctx.$state;

    /**
     * This is the only way to detect `seeked`. Unfortunately while the player is `paused` `seeking`
     * and `seeked` will fire at the same time, there are no updates in-between -_-. We need an
     * artificial delay between the two events.
     */
    if (seeking() && buffered > currentTime()) {
      this._onSeeked(trigger);
    }
  }

  protected _onSeeked(trigger: Event) {
    const { paused, currentTime } = this._ctx.$state;

    window.clearTimeout(this._seekingTimer);

    this._seekingTimer = window.setTimeout(
      () => {
        this._notify('seeked', currentTime(), trigger);
        this._seekingTimer = -1;
      },
      paused() ? 100 : 0,
    );
  }

  protected _onEnded(trigger: Event) {
    const { seeking } = this._ctx.$state;
    if (seeking()) this._onSeeked(trigger);
    this._notify('end', undefined, trigger);
  }

  protected _onStateChange(state: YouTubePlayerStateValue, trigger: Event) {
    const { paused } = this._ctx.$state,
      isPlaying = state === YouTubePlayerState._Playing,
      isBuffering = state === YouTubePlayerState._Buffering;

    if (isBuffering) this._notify('waiting', undefined, trigger);

    // Attempt to detect `play` events early.
    if (paused() && (isBuffering || isPlaying)) {
      this._playPromise?.resolve();
      this._playPromise = null;
      this._notify('play', undefined, trigger);
    }

    switch (state) {
      case YouTubePlayerState._Cued:
        this._onReady(trigger);
        break;
      case YouTubePlayerState._Playing:
        this._notify('playing', undefined, trigger);
        break;
      case YouTubePlayerState._Paused:
        this._onPause(trigger);
        break;
      case YouTubePlayerState._Ended:
        this._onEnded(trigger);
        break;
    }

    this._state = state;
  }

  protected override _onMessage({ info }: YouTubeMessage, event: MessageEvent) {
    if (!info) return;

    const { title, duration, playbackRate } = this._ctx.$state;

    if (isObject(info.videoData) && info.videoData.title !== title()) {
      this._notify('title-change', info.videoData.title, event);
    }

    if (isNumber(info.duration) && info.duration !== duration()) {
      if (isNumber(info.videoLoadedFraction)) {
        const buffered = info.progressState?.loaded ?? info.videoLoadedFraction * info.duration,
          seekable = new TimeRange(0, info.duration);
        this._onProgress(buffered, seekable, event);
      }

      this._notify('duration-change', info.duration, event);
    }

    if (isNumber(info.playbackRate) && info.playbackRate !== playbackRate()) {
      this._notify('rate-change', info.playbackRate, event);
    }

    if (info.progressState) {
      const {
        current,
        seekableStart,
        seekableEnd,
        loaded,
        duration: _duration,
      } = info.progressState;
      this._onTimeUpdate(current, event);
      this._onProgress(loaded, new TimeRange(seekableStart, seekableEnd), event);
      if (_duration !== duration()) {
        this._notify('duration-change', _duration, event);
      }
    }

    if (isNumber(info.volume) && isBoolean(info.muted)) {
      const detail = {
        muted: info.muted,
        volume: info.volume / 100,
      };

      this._notify('volume-change', detail, event);
    }

    if (isNumber(info.playerState) && info.playerState !== this._state) {
      this._onStateChange(info.playerState, event);
    }
  }

  protected _reset() {
    this._state = -1;
    this._seekingTimer = -1;
    this._played = 0;
    this._playedRange = new TimeRange(0, 0);
    this._playPromise = null;
    this._pausePromise = null;
  }
}
