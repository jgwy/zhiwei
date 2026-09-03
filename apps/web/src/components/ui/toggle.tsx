import { cn } from "@/lib/utils";

export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={cn("toggle", checked && "toggle-on")}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}
