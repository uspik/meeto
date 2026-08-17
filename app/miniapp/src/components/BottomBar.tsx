interface Props {
  label: string;
  onMain(): void;
  onCreate?(): void;
  /** день в прошлом: создавать там нечего, но кнопка остаётся на месте */
  createOff?: boolean;
  offHint?: string;
}

export function BottomBar({ label, onMain, onCreate, createOff, offHint }: Props) {
  return (
    <div className="bottombar">
      <button className="tb" onClick={onMain}>{label}</button>
      {onCreate && (
        <button
          className={`plus ${createOff ? "off" : ""}`}
          disabled={createOff}
          title={createOff ? offHint ?? "В прошлом мероприятие не создать" : "Новое мероприятие"}
          onClick={() => !createOff && onCreate()}
        >
          +
        </button>
      )}
    </div>
  );
}
