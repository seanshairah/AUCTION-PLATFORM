import { BulkUpload } from '@/components/seller/BulkUpload';

export const metadata = { title: 'Bulk upload' };

export default function BulkPage() {
  return (
    <>
      <div className="acc-title"><div><h1>Bulk upload</h1><p>For banks, insurers and customs sales: one CSV per batch, all or nothing, never duplicated.</p></div></div>
      <BulkUpload />
    </>
  );
}
