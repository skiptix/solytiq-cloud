interface IconProps {
  name: string;
  size?: number;
  color?: string;
  className?: string;
}

function Icon({ name, size = 20, color, className }: IconProps) {
  return (
    <span
      className={`material-symbols-outlined${className ? ` ${className}` : ''}`}
      style={{ fontSize: size, color, lineHeight: 1 }}
    >
      {name}
    </span>
  );
}

export default Icon;
