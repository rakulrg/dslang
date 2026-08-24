/**
 * Preloads an image via the browser cache and resolves only once it has fully
 * loaded. Used to guarantee a hero image never becomes visible before its
 * bytes are available (prevents the previous image flashing through).
 */
export function preloadImage(src: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(src);
    img.onerror = () => reject(new Error(`Image failed to load: ${src}`));
    img.src = src;
  });
}
