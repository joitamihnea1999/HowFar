/**
 * First-paint map placeholder (phone-first design): a realistic,
 * NON-interactive dark basemap texture shown behind the map container from the
 * very first frame — so no state ever shows the forbidden dark void — until the
 * deferred MapLibre engine mounts and its opaque canvas covers it. It is an inline
 * SVG (blocks, arterials, a river, a park), a few hundred bytes with ZERO network
 * and ZERO JavaScript on the critical path, so the task-017 deferred-load
 * performance contract is fully preserved (no map bundle is pulled forward).
 *
 * It carries the dark map palette (map base `#0e130f`) so the live map
 * fades in over a texture of the same tone rather than a jarring swap. Marked
 * `aria-hidden` and pointer-transparent — it is decoration standing in for the
 * live map, never a control.
 */

interface MapPlaceholderProps {
  /** Hide once the live map has painted (its canvas then covers this). */
  hidden: boolean;
}

export default function MapPlaceholder({ hidden }: MapPlaceholderProps) {
  return (
    <div
      data-testid="map-placeholder"
      data-map-placeholder={hidden ? "covered" : "visible"}
      aria-hidden="true"
      hidden={hidden}
      className="pointer-events-none absolute inset-0 -z-10 bg-[#0e130f]"
    >
      <svg
        className="h-full w-full"
        viewBox="0 0 390 844"
        preserveAspectRatio="xMidYMid slice"
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* Land base */}
        <rect x="0" y="0" width="390" height="844" fill="#0e130f" />
        {/* A park patch (greenish) */}
        <rect x="232" y="150" width="118" height="150" rx="10" fill="#13221a" />
        {/* A second park / green square */}
        <rect x="44" y="540" width="96" height="104" rx="8" fill="#122019" />
        {/* River band (diagonal, muted blue) */}
        <path d="M-20 640 C 90 600, 150 700, 280 660 S 430 720, 440 690 L 440 760 C 330 800, 200 740, 90 780 S -10 740, -20 730 Z" fill="#0c1622" opacity="0.9" />
        {/* Block grid — subtle lighter rectangles reading as city blocks */}
        <g fill="#141b16">
          {Array.from({ length: 7 }).map((_, r) =>
            Array.from({ length: 5 }).map((_, c) => {
              // Skip blocks that fall over the park / river bands for realism.
              const x = 16 + c * 74;
              const y = 40 + r * 118;
              if (y > 520 && y < 660) return null;
              return <rect key={`${r}-${c}`} x={x} y={y} width="56" height="86" rx="4" />;
            }),
          )}
        </g>
        {/* Arterials — thin road lines over the grid */}
        <g stroke="#0a0e0b" strokeWidth="6" fill="none" opacity="0.85">
          <path d="M0 132 H390 M0 368 H390 M0 486 H390" />
          <path d="M90 0 V844 M238 0 V844 M312 0 V844" />
        </g>
        <g stroke="#1a231c" strokeWidth="2" fill="none" opacity="0.7">
          <path d="M0 132 H390 M0 368 H390 M0 486 H390" />
          <path d="M90 0 V844 M238 0 V844 M312 0 V844" />
        </g>
      </svg>
    </div>
  );
}
