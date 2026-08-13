/**
 * Placeholder presenter cutout — the illustrated stand-in that occupies the
 * exact slot the keyed HeyGen video drops into in M2. `speaking` drives the
 * mouth/idle swap and the bob animation, `tilt` is the per-scene lean.
 */
export function AvatarPlaceholder({ speaking, tilt }: { speaking: boolean; tilt: number }) {
  return (
    <div
      style={{
        position: "absolute",
        bottom: 0,
        left: "50%",
        marginLeft: -160,
        width: 320,
        height: 390,
        transformOrigin: "50% 100%",
        transform: `rotate(${tilt}deg)`,
        transition: "transform .9s cubic-bezier(.22,1,.36,1)",
        pointerEvents: "none",
        zIndex: 4,
      }}
    >
      <div
        style={{
          position: "absolute",
          left: "50%",
          bottom: -6,
          transform: "translateX(-50%)",
          width: 360,
          height: 40,
          background: "radial-gradient(closest-side,rgba(30,58,138,.22),transparent)",
        }}
      />
      <div style={{ position: "absolute", inset: 0, animation: "breathe 5s ease-in-out infinite" }}>
        <svg viewBox="0 0 320 390" width="320" height="390" style={{ display: "block" }}>
          <g
            style={{
              animation: "bob 3.2s ease-in-out infinite",
              animationPlayState: speaking ? "running" : "paused",
              transformBox: "fill-box",
              transformOrigin: "50% 90%",
            }}
          >
            <ellipse cx="160" cy="126" rx="13" ry="15" fill="#E3AC7F" />
            <rect x="147" y="108" width="26" height="26" fill="#E3AC7F" />
            <circle cx="117" cy="76" r="8" fill="#EFBE93" />
            <circle cx="203" cy="76" r="8" fill="#EFBE93" />
            <ellipse cx="160" cy="70" rx="44" ry="50" fill="#EFBE93" />
            <path
              d="M116,66 Q114,16 160,14 Q206,16 204,66 Q204,50 186,44 Q168,38 156,42 Q134,38 124,50 Q116,56 116,66 Z"
              fill="#3A3129"
            />
            <rect x="134" y="58" width="17" height="4" rx="2" fill="#3A3129" />
            <rect x="169" y="58" width="17" height="4" rx="2" fill="#3A3129" />
            <circle cx="143" cy="72" r="3.4" fill="#2B2B2B" />
            <circle cx="177" cy="72" r="3.4" fill="#2B2B2B" />
            <path
              d="M160,74 L160,86 Q160,89 155,89"
              stroke="#D9A26F"
              strokeWidth="2.5"
              fill="none"
              strokeLinecap="round"
            />
            <rect x="149" y="97" width="22" height="3.5" rx="1.75" fill="#A05F42" opacity={speaking ? 0 : 1} />
            <ellipse
              cx="160"
              cy="99"
              rx="9"
              ry="6.5"
              fill="#833F28"
              opacity={speaking ? 1 : 0}
              style={{
                animation: "talk .42s ease-in-out infinite",
                transformBox: "fill-box",
                transformOrigin: "center",
              }}
            />
          </g>
          <path
            d="M160,132 C 102,132 68,156 60,202 L48,390 L272,390 L260,202 C252,156 218,132 160,132 Z"
            fill="#26334D"
          />
          <path d="M134,136 Q160,150 186,136 L172,222 L148,222 Z" fill="#FFFFFF" />
          <path d="M134,136 L160,132 L150,226 L112,172 Z" fill="#1D2940" />
          <path d="M186,136 L160,132 L170,226 L208,172 Z" fill="#1D2940" />
          <polygon points="160,148 169,157 162,200 170,216 160,232 150,216 158,200 151,157" fill="#3D5BF5" />
          <rect x="216" y="212" width="16" height="9" rx="1.5" fill="#FFFFFF" />
          <path d="M60,202 Q56,280 52,390 L94,390 Q90,280 96,206 Z" fill="#202B42" />
          <path
            d="M260,202 Q264,280 268,390 L226,390 Q230,280 224,206 Z"
            fill="#202B42"
            style={{
              animation: "gesture 4.6s ease-in-out infinite",
              transformBox: "fill-box",
              transformOrigin: "50% 8%",
            }}
          />
          <circle cx="160" cy="248" r="3" fill="#0F1829" />
          <circle cx="160" cy="276" r="3" fill="#0F1829" />
        </svg>
      </div>
    </div>
  );
}
