// YouTube is deliberately excluded (its terms forbid downloading). Remove the checks
// that call this if you have a legitimate reason and the rights to do so.
export function isYouTubeUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    const is = (d) => host === d || host.endsWith('.' + d);
    return is('youtu.be') || is('youtube.com') || is('youtube-nocookie.com') || is('googlevideo.com');
  } catch {
    return false;
  }
}
