"use client";

import type { AppointmentSettings } from "@/lib/appointments/settings";
import type { AppointmentSettingsTab } from "@/lib/appointments/settings-tabs";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import {
  BookingRules,
  type ChannelOption,
  type Exclusion,
  type TemplateOption,
} from "./booking-rules";
import {
  Departments,
  Locations,
  Services,
  type Department,
  type Location,
  type Service,
} from "./catalogue";
import { Specialists, type SpecialistRow } from "./specialists";

export function AppointmentsSettings({
  initialTab,
  orgTimezone,
  rules,
  locations,
  departments,
  services,
  specialists,
  templates,
  channels,
  exclusions,
  users,
  financeBranches,
}: {
  /** From ?tab=; the page opens on Locations while there are none. */
  initialTab: AppointmentSettingsTab;
  orgTimezone: string;
  rules: AppointmentSettings;
  locations: Location[];
  departments: Department[];
  services: Service[];
  specialists: SpecialistRow[];
  templates: TemplateOption[];
  channels: ChannelOption[];
  exclusions: Exclusion[];
  users: Array<{ id: string; name: string }>;
  /** Phase B: finance branch codes the member may read (empty: the code is typed). */
  financeBranches: Array<{ code: string; name: string }>;
}) {
  return (
    <Tabs defaultValue={initialTab} className="flex flex-col gap-4">
      <TabsList className="w-fit flex-wrap">
        <TabsTrigger value="locations">Locations</TabsTrigger>
        <TabsTrigger value="departments">Departments</TabsTrigger>
        <TabsTrigger value="services">Services</TabsTrigger>
        <TabsTrigger value="doctors">Doctors and hours</TabsTrigger>
        <TabsTrigger value="rules">Booking rules</TabsTrigger>
      </TabsList>
      <TabsContent value="locations">
        <Locations
          items={locations}
          defaultTimezone={orgTimezone}
          financeBranches={financeBranches}
        />
      </TabsContent>
      <TabsContent value="departments">
        <Departments items={departments} />
      </TabsContent>
      <TabsContent value="services">
        <Services items={services} departments={departments} />
      </TabsContent>
      <TabsContent value="doctors">
        <Specialists
          specialists={specialists}
          locations={locations}
          departments={departments}
          services={services}
          users={users}
          defaultSlotMin={rules.slot_granularity_min}
        />
      </TabsContent>
      <TabsContent value="rules">
        <BookingRules
          initial={rules}
          templates={templates}
          channels={channels}
          exclusions={exclusions}
        />
      </TabsContent>
    </Tabs>
  );
}
