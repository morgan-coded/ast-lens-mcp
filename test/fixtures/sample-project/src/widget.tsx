import React, { useState } from "react";
import { UserService } from "./models";

export interface WidgetProps {
  title: string;
}

export function Widget(props: WidgetProps): React.ReactElement {
  const [count, setCount] = useState(0);
  const service = UserService.create();

  return (
    <div className="widget">
      <h1>{props.title}</h1>
      <span>{count}</span>
      <button onClick={() => setCount(count + 1)}>Increment</button>
      <p>Users: {service.count}</p>
    </div>
  );
}

export default Widget;
