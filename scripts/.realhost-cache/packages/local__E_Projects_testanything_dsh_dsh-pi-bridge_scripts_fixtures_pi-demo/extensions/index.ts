import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({
    name: "demo_echo",
    label: "Demo echo",
    description: "Echo uppercased.",
    parameters: Type.Object({ text: Type.String({ description: "text" }) }),
    async execute (_id, params) { return { content: [{ type: "text", text: String(params.text).toUpperCase() }] } }
  });
}
