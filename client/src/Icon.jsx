// Renders the *real* markup of an existing `src/icons/*.svg` file, imported
// verbatim via Vite's built-in `?raw` query (no SVGR, no new dependency -
// e.g. `import playArrowSvg from "./icons/play_arrow_....svg?raw"`).
//
// This is deliberately real inline SVG rather than an <img src> or a CSS
// `mask-image`: a CSS mask of these particular files (unusual negative-origin
// `viewBox="0 -960 960 960"`) rendered as a plain filled square in some
// browsers instead of the icon's actual shape. Inlining the exact SVG markup
// has no such risk - the shape is guaranteed to render exactly as authored.
//
// Every icon file hardcodes a single `fill="#e3e3e3"` on its root <svg>
// (inherited by its one <path>); swapping that for `fill="currentColor"`
// lets the icon follow whatever CSS `color` the surrounding button sets for
// its default/hover/disabled/primary states.
const FILL_ATTRIBUTE_PATTERN = /fill="#[0-9a-fA-F]{3,8}"/;

function Icon({ svg, className }) {
  const markup = svg.replace(FILL_ATTRIBUTE_PATTERN, 'fill="currentColor"');

  return (
    <span
      aria-hidden="true"
      className={className ? `icon ${className}` : "icon"}
      // Trusted, build-time-bundled local SVG source - never user input.
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}

export default Icon;
