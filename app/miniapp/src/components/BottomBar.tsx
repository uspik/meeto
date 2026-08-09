interface Props { label: string; onMain(): void; onCreate?(): void }

export function BottomBar({ label, onMain, onCreate }: Props) {
  return (
    <div className="bottombar">
      <button className="tb" onClick={onMain}>{label}</button>
      {onCreate && <button className="plus" onClick={onCreate}>+</button>}
    </div>
  );
}
