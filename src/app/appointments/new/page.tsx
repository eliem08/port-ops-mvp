import { Card } from "@/components/ui";
import { SyntheticTag } from "@/components/synthetic-tag";
import { NewAppointmentForm } from "./new-form";

export default function NewAppointmentPage() {
  return (
    <div className="mx-auto max-w-lg space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-ink">New appointment</h1>
        <SyntheticTag />
      </div>
      <Card title="Appointment">
        <NewAppointmentForm />
      </Card>
    </div>
  );
}
