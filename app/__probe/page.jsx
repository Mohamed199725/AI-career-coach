import { Textarea } from "@/components/ui/textarea";

// Temporary harness: renders a Textarea with the same kinds of props EntryForm passes.
export default function ProbePage() {
  return (
    <div style={{ padding: 24 }}>
      <label htmlFor="with-error-object">
        error = object (what useForm({errors}) can provide)
      </label>
      <Textarea
        id="with-error-object"
        defaultValue=""
        error={{ type: "required", message: "Description is required" }}
      />

      <label htmlFor="with-error-string">error = string (valid usage)</label>
      <Textarea id="with-error-string" defaultValue="" error="Required" />

      <label htmlFor="with-error-undefined">error = undefined</label>
      <Textarea id="with-error-undefined" defaultValue="" error={undefined} />
    </div>
  );
}
