export const CAMERA_FOV = 30;
export const CAMERA_OFFSETS = {
  side: [3.2, -5.7, 1.9],
  top: [0.001, 0, 9],
  follow: [-5.5, -4.8, 2.8],
  // Pulled back along the side view so the fly, its pads and the TV above it all fit.
  band: [9.6, -17.1, 5.1],
};
/** Band view looks between the fly and the TV behind it. */
export const BAND_FOCUS = [-1, 4, 1.5];
export function cameraFit(view, aspect) {
  // The band view is as tall as it is wide (TV above the fly), so wide panes need pulling back too.
  return Math.max(view === 'band' ? 1.3 : 1, (view === 'top' ? 1.4 : 1.55) / aspect);
}
export function cameraPullback(pose) {
  return 1 + 0.5 * Math.max(0, Math.min(1, pose.wingOpen || 0));
}
/** Track a point inside the specimen, including its bank, pitch and heading. */
export function cameraTarget(p) {
  const cy = Math.cos(p.yaw),
    sy = Math.sin(p.yaw),
    cp = Math.cos(p.pitch),
    sp = Math.sin(p.pitch),
    cr = Math.cos(p.bank),
    sr = Math.sin(p.bank);
  return [
    p.z - 0.4 * cy * cp + 0.68 * (cy * sp * cr + sy * sr),
    p.x - 0.4 * sy * cp + 0.68 * (sy * sp * cr - cy * sr),
    p.y + 0.4 * sp + 0.68 * cp * cr,
  ];
}
