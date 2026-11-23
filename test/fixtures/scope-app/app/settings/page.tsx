import { SettingsForm } from '@/components/SettingsForm';
import { formatName } from '@/lib';

export default function SettingsPage() {
  return (
    <>
      <h1>{formatName('Ada', 'Lovelace')}</h1>
      <SettingsForm />
    </>
  );
}
