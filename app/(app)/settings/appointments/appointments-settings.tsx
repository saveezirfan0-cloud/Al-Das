"use client";

import type { AppointmentSettings } from "@/lib/appointments/settings";
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
}: {
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
}) {
  return (
    <Tabs defaultValue="specialists" className="flex flex-col gap-4">
      <TabsList className="w-fit flex-wrap">
        <TabsTrigger value="specialists">Specialists</TabsTrigger>
        <TabsTrigger value="locations">Locations</TabsTrigger>
        <TabsTrigger value="departments">Departments</TabsTrigger>
        <TabsTrigger value="services">Services</TabsTrigger>
        <TabsTrigger value="rules">Booking rules</TabsTrigger>
      </TabsList>
      <TabsContent value="specialists">
        <Specialists
          specialists={specialists}
          locations={locations}
          departments={departments}
          services={services}
          users={users}
        />
      </TabsContent>
      <TabsContent value="locations">
        <Locations items={locations} defaultTimezone={orgTimezone} />
      </TabsContent>
      <TabsContent value="departments">
        <Departments items={departments} />
      </TabsContent>
      <TabsContent value="services">
        <Services items={services} departments={departments} />
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
