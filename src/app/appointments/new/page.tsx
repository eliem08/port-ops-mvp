import { Card, SyntheticTag } from "@/components/ui";
import { NewAppointmentForm } from "./new-form";

export default function NewAppointmentPage() {
  return (
    <div className="mx-auto max-w-lg space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-ink">New appointment</h1>
        <SyntheticTag />
      </div>
      <Card title="Synthetic appointment record">
        <NewAppointmentForm />
      </Card>
    </div>
  );
}
