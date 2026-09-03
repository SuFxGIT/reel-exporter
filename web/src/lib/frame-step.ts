/**
 * Steps the video by `n` frames. Targets the middle of the destination frame so
 * rational frame rates (24000/1001) and browsers that snap currentTime after an MSE
 * seek both land on the intended frame.
 */
export function stepFrames(
  video: HTMLVideoElement,
  frameTime: number | null,
  fps: number,
  n: number
): void {
  video.pause()
  const frame = 1 / (fps > 0 ? fps : 24)
  const base =
    frameTime ??
    Math.floor(video.currentTime * (fps > 0 ? fps : 24) + 1e-4) * frame
  const target = base + (n + 0.5) * frame
  const max = Number.isFinite(video.duration)
    ? Math.max(0, video.duration - frame)
    : Number.MAX_SAFE_INTEGER
  video.currentTime = Math.min(Math.max(target, 0), max)
}
