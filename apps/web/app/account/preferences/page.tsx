import { Preferences } from '@/components/account/Preferences';
import { apiOrNull } from '@/lib/api';

export const metadata = { title: 'Preferences' };

export default async function PreferencesPage() {
  const view = await apiOrNull<Parameters<typeof Preferences>[0]['initial']>('/me/preferences');
  return (
    <>
      <div className="acc-title"><div><h1>Message preferences</h1><p>Choose how each kind of message reaches you. Marketing is off unless you switch it on.</p></div></div>
      {view ? <Preferences initial={view} /> : <p className="muted">Could not load your preferences.</p>}
    </>
  );
}
