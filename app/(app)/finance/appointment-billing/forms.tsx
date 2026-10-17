"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { FileUpload } from "@/components/shell/file-upload";
import { MAX_APPOINTMENT_BYTES } from "@/lib/finance/appointment-mapping";

import { importAppointmentUpload, previewAppointmentFile } from "./actions";

const withFile = (file: File) => {
  const fd = new FormData();
  fd.set("file", file);
  return fd;
};

/** The appointment export upload: preview of the columns that will be read, then import. */
export function AppointmentUpload() {
  const router = useRouter();
  return (
    <FileUpload
      label="Unite appointment export"
      accept={[".csv", ".xlsx"]}
      maxBytes={MAX_APPOINTMENT_BYTES}
      hint="A .csv or .xlsx file up to 10 MB, one month at a time. Only the appointment columns are read (never a name, date of birth, ID number, phone or insurance member id); the file itself is not kept."
      preview={(file) => previewAppointmentFile(withFile(file))}
      confirmLabel="Import"
      onConfirm={async (file) => {
        const res = await importAppointmentUpload(withFile(file));
        if (res.ok) {
          toast.success(res.message ?? "Imported");
          const s = res.data;
          if (s && s.unmappedClinics.length > 0)
            toast.warning(
              `Clinic name(s) not mapped to a branch: ${s.unmappedClinics.join("; ")}. Map them under Finance, Reference data; until then only people who see every branch see these appointments.`,
            );
          if (s && !s.has.clinic)
            toast.warning("The file has no clinic column, so its appointments have no branch.");
          if (s && !s.has.duration)
            toast.warning(
              "The file has no appointment length, so hours and utilisation cannot be worked out.",
            );
          router.refresh();
        } else toast.error(res.error);
        return res.ok;
      }}
    />
  );
}
