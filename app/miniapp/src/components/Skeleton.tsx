/**
 * Заглушки на время загрузки.
 *
 * Раньше вкладка открывалась пустой, а через мгновение в неё резко падали
 * готовые строки. Скелетон занимает то же место, что и будущая строка,
 * поэтому подмена данных не сдвигает вёрстку — видно только проявление.
 */

interface Props { rows?: number }

export function SkeletonRows({ rows = 3 }: Props) {
  return (
    <>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="row sk" style={{ animationDelay: `${i * 90}ms` }}>
          <span className="ico lg sk-b" />
          <div className="meta">
            <div className="sk-l w60" />
            <div className="sk-l w35" />
          </div>
        </div>
      ))}
    </>
  );
}

/** Вертикальные блоки на ленте дня. */
export function SkeletonDay() {
  return (
    <div className="dsk">
      {[64, 96, 48].map((h, i) => (
        <div key={i} className="sk-blk sk" style={{ height: h, animationDelay: `${i * 90}ms` }} />
      ))}
    </div>
  );
}
