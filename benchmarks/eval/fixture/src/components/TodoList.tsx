interface TodoListProps {
  items: string[];
}

export function TodoList({ items }: TodoListProps) {
  return (
    <ul>
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}
