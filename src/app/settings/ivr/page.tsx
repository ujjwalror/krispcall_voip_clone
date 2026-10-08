import { IVRManagement } from '@/components/phone-system/IVRManagement';

export const metadata = {
  title: 'IVR & Inbound Routing | VoIP Hub',
  description: 'Manage automated auto-attendant menus, keypad options, and inbound call routing.',
};

export default function IvrSettingsPage() {
  return (
    <div className="p-6">
      <IVRManagement />
    </div>
  );
}
