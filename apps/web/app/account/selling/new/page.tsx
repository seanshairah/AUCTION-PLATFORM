import { NewConsignment } from '@/components/seller/NewConsignment';

export const metadata = { title: 'New consignment' };

export default function NewConsignmentPage() {
  return (
    <>
      <div className="acc-title"><div><h1>New consignment</h1><p>Start a consignment, add your lots, then read and sign the note.</p></div></div>
      <NewConsignment />
    </>
  );
}
