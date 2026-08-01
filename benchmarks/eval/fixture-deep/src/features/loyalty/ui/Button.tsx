export interface ButtonProps {
  label: string;
  onClick: () => void;
}

export const Button = ({ label, onClick }: ButtonProps) => (
  <button type="button" onClick={onClick}>{label}</button>
);
