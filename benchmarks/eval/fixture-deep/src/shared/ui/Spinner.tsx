export interface SpinnerProps {
  size?: number;
  label?: string;
}

export const Spinner = ({ size = 16, label = 'Loading' }: SpinnerProps) => (
  <span role="status" aria-label={label} style={{ width: size, height: size }} />
);
