/**
 * Pixel-art crab used as the empty-state mascot.
 *
 * Drawn from rects on a 24×18 grid so it stays crisp at any size and needs no
 * image asset. Color is Claude's orange, fixed in both themes.
 */
export function ClaudeCrab({ className = '' }: { className?: string }) {
  const ORANGE = '#D97757';
  const EYE = '#FBF3EF';

  const px = (x: number, y: number, w = 1, h = 1, fill = ORANGE) => (
    <rect key={`${x}-${y}-${w}-${h}`} x={x} y={y} width={w} height={h} fill={fill} />
  );

  return (
    <svg
      viewBox="0 0 24 19"
      className={className}
      role="img"
      aria-label="Claude"
      shapeRendering="crispEdges"
    >
      {/* body */}
      {px(7, 5, 10, 1)}
      {px(6, 6, 12, 6)}
      {px(7, 12, 10, 1)}

      {/* eyes */}
      {px(9, 7, 2, 2, EYE)}
      {px(14, 7, 2, 2, EYE)}

      {/* left claw + arm */}
      {px(3, 4, 2, 2)}
      {px(2, 6, 2, 3)}
      {px(4, 7, 1, 1)}
      {px(5, 7, 1, 2)}

      {/* right claw + arm */}
      {px(19, 4, 2, 2)}
      {px(20, 6, 2, 3)}
      {px(19, 7, 1, 1)}
      {px(18, 7, 1, 2)}

      {/* legs */}
      {px(8, 13, 1, 2)}
      {px(7, 15, 2, 1)}
      {px(11, 13, 1, 3)}
      {px(10, 16, 2, 1)}
      {px(13, 13, 1, 3)}
      {px(13, 16, 2, 1)}
      {px(16, 13, 1, 2)}
      {px(16, 15, 2, 1)}
    </svg>
  );
}
