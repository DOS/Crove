import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useRef, useState, type FormEvent } from 'react';
import { Button, Card, ErrorText, Input, Logo } from '../components/ui.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { auth } from '../lib/auth.ts';
import { MyInvites } from './invites.tsx';

export function OnboardingPage() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const create = useMutation(
    orpc.org.create.mutationOptions({
      onSuccess: async (org) => {
        await queryClient.invalidateQueries();
        await navigate({ to: '/o/$slug/inbox', params: { slug: org.slug } });
      },
    }),
  );

  // One idempotency key per name: a retried submit returns the org the first one created instead of a second.
  const attempt = useRef<{ name: string; key: string } | null>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    // The server trims the name, so the key follows the trimmed name.
    const trimmed = name.trim();
    if (attempt.current?.name !== trimmed) attempt.current = { name: trimmed, key: crypto.randomUUID() };
    create.mutate({ name: trimmed, idempotencyKey: attempt.current.key });
  }

  return (
    <main className="flex min-h-full flex-col items-center justify-center gap-6 bg-canvas px-4 py-16">
      <div className="w-full max-w-md">
        <MyInvites />
      </div>
      <Card className="w-full max-w-md p-6">
        <Logo />
        <h1 className="mt-6 text-lg font-semibold text-fg">Tạo tổ chức đầu tiên</h1>
        <p className="mt-1 text-sm text-fg-2">Mỗi tổ chức có sổ sách, hộp thư chứng từ và thành viên riêng.</p>
        <form className="mt-6 space-y-3" onSubmit={submit}>
          <label className="block text-sm">
            <span className="mb-1 block text-fg-2">Tên công ty hoặc hộ kinh doanh</span>
            <Input required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} placeholder="Công ty TNHH ABC" />
          </label>
          {create.error && <ErrorText>{errorMessage(create.error)}</ErrorText>}
          <Button type="submit" variant="primary" className="w-full" disabled={create.isPending}>
            {create.isPending ? 'Đang tạo…' : 'Tạo tổ chức'}
          </Button>
        </form>
        <button className="mt-4 text-sm text-fg-3 hover:text-fg-2" onClick={() => void auth().signOut()}>
          Đăng xuất
        </button>
      </Card>
    </main>
  );
}
