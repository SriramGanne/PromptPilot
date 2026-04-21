import Image from "next/image";

// Intrinsic pixel dimensions of public/Transparent_Logo.png.
// Keeping these in the component (instead of hard-coding 1:1) means the
// wordmark always renders at its native aspect ratio — no vertical squash
// from forcing a wide logo into a square box.
const LOGO_W = 963;
const LOGO_H = 247;
const LOGO_ASPECT = LOGO_W / LOGO_H;

/**
 * PromptPilot brand mark.
 *
 * The asset is a horizontal WORDMARK (icon + "PromptPilot" text baked into
 * one image), so we size by height and let the width flow from the intrinsic
 * aspect ratio. Never pair this component with a separate "PromptPilot"
 * text element — the wordmark already says it, and doing both is visual
 * redundancy that weakens the brand.
 *
 * @param {object}  props
 * @param {number}  [props.height=32]  - Rendered height in px; width auto
 * @param {boolean} [props.loading]    - Pulse animation while agent is active
 * @param {string}  [props.className]
 * @param {boolean} [props.priority]   - LCP preload (true for above-the-fold)
 */
export default function BrandMark({
  height = 32,
  loading = false,
  className = "",
  priority = false,
}) {
  const width = Math.round(height * LOGO_ASPECT);
  return (
    <Image
      src="/Transparent_Logo.png"
      alt="PromptPilot - From Chaos to Expert Prompts"
      width={LOGO_W}
      height={LOGO_H}
      priority={priority}
      className={`shrink-0 select-none ${
        loading ? "[animation:brand-pulse_1.8s_ease-in-out_infinite]" : ""
      } ${className}`}
      // Inline style wins over next/image's intrinsic sizing and locks the
      // final rendered dimensions to our chosen height + derived width.
      // The stacked drop-shadows trace a soft white halo around the logo's
      // alpha silhouette so the dark "chaos" side stays legible on the
      // near-black background; brightness lifts midtones without washing
      // out the purple node. When loading, the brand-pulse animation takes
      // over `filter`, so this static treatment only applies at rest.
      style={{
        height,
        width,
        filter: loading
          ? undefined
          : "drop-shadow(0 0 1.5px rgba(255,255,255,0.85)) drop-shadow(0 0 0.5px rgba(255,255,255,0.6)) brightness(1.2)",
      }}
    />
  );
}
