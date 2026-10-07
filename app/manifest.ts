import type { MetadataRoute } from "next";
import { siteName } from "./site";

// The game's backdrop, so a Home Screen launch never flashes white.
const backgroundColor = "#01040a";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: siteName,
    short_name: siteName,
    start_url: "/",
    // Added to the iPhone Home Screen, "standalone" is what removes Safari's
    // address and tab bars. iOS Safari ignores "fullscreen", so asking for it
    // would only fall back to an ordinary browser tab there.
    display: "standalone",
    background_color: backgroundColor,
    theme_color: backgroundColor,
  };
}
