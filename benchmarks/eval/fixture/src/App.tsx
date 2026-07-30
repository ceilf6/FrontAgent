import { Button } from "./components/Button";
import { TodoList } from "./components/TodoList";

export default function App() {
  return (
    <main>
      <h1>Eval Fixture</h1>
      <Button label="Add" onClick={() => {}} />
      <TodoList items={["a", "b"]} />
    </main>
  );
}
