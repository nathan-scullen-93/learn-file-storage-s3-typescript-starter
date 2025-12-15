import React from "react";
import { createRoot } from "react-dom/client";

function Greeter(props) {
  return <div>Hello {props.user}</div>;
}

document.body.innerHTML = "<div id='root'></div>";
const root = createRoot(document.getElementById("root"));
root.render(<Greeter user="Admin" />);
export default Greeter;