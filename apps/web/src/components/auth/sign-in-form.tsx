import type { Me } from '@foundry/contracts';
import { ArrowRight, CircleAlert } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useSignIn } from '@/lib/api/hooks/auth';
import { errorMessage, isApiError } from '@/lib/api/errors';
import {
  ACCESS_CODE_PLACEHOLDER,
  ACCESS_CODE_PREFIX,
  ACCESS_CODE_SYMBOLS,
  accessCodeSymbols,
  caretAfterMask,
  fullAccessCode,
  maskAccessCodeInput,
} from '@/lib/auth/access-code';
import { cn } from '@/lib/utils';

interface SignInFormValues {
  code: string;
}

export function validateAccessCodeField(value: string): true | string {
  const count = accessCodeSymbols(value).length;
  if (count === 0) return 'Enter your access code.';
  if (count < ACCESS_CODE_SYMBOLS) {
    return `Access codes have ${ACCESS_CODE_SYMBOLS} characters after ${ACCESS_CODE_PREFIX} — you’ve entered ${count}.`;
  }
  return true;
}

/**
 * Access-code sign-in form: masked input (fixed "FA-" prefix, groups of five), client validation,
 * and mapping of invalid / locked-out / rate-limited responses to accessible error messages.
 */
export function SignInForm({ onSignedIn }: { onSignedIn: (me: Me) => void }) {
  const signIn = useSignIn();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const ids = { hint: useId(), error: useId(), count: useId(), form: useId() };

  const { control, handleSubmit, setError, formState, watch } = useForm<SignInFormValues>({
    defaultValues: { code: '' },
    mode: 'onSubmit',
    reValidateMode: 'onChange',
  });
  const symbols = accessCodeSymbols(watch('code')).length;

  useEffect(() => {
    if (lockedUntil === null) return;
    const ms = lockedUntil - Date.now();
    const timer = setTimeout(
      () => {
        setLockedUntil(null);
      },
      Math.max(0, ms),
    );
    return () => {
      clearTimeout(timer);
    };
  }, [lockedUntil]);

  const onSubmit = handleSubmit((values) => {
    setFormError(null);
    signIn.mutate(
      { accessCode: fullAccessCode(values.code) },
      {
        onSuccess: (me) => {
          onSignedIn(me);
        },
        onError: (error) => {
          if (
            isApiError(error) &&
            (error.code === 'invalid_access_code' || error.code === 'validation_failed')
          ) {
            setError('code', { type: 'server', message: errorMessage(error) }, { shouldFocus: true });
            return;
          }
          if (isApiError(error) && (error.code === 'locked_out' || error.code === 'rate_limited')) {
            setLockedUntil(Date.now() + (error.retryAfter ?? 60) * 1000);
          }
          setFormError(errorMessage(error));
        },
      },
    );
  });

  const fieldError = formState.errors.code?.message;
  const locked = lockedUntil !== null;

  return (
    <form
      id={ids.form}
      onSubmit={(e) => void onSubmit(e)}
      noValidate
      className="grid gap-5"
      aria-describedby={ids.hint}
    >
      {formError ? (
        <Alert variant="destructive" live="alert" title={locked ? 'Sign-in paused' : 'Couldn’t sign you in'}>
          {formError}
        </Alert>
      ) : null}

      <div className="grid gap-2">
        <Label htmlFor="access-code">Access code</Label>
        <Controller
          control={control}
          name="code"
          rules={{ validate: validateAccessCodeField }}
          render={({ field }) => (
            <div
              className={cn(
                'flex h-12 items-center rounded-lg border bg-transparent shadow-xs transition-[border-color,box-shadow]',
                'focus-within:border-ring focus-within:ring-1 focus-within:ring-ring',
                fieldError
                  ? 'border-destructive ring-1 ring-destructive/40'
                  : 'border-input hover:border-foreground/45',
              )}
            >
              <span
                aria-hidden
                className="pl-3.5 font-mono text-[15px] tracking-wider text-muted-foreground select-none"
              >
                {ACCESS_CODE_PREFIX}
              </span>
              <input
                ref={(node) => {
                  inputRef.current = node;
                  field.ref(node);
                }}
                id="access-code"
                name={field.name}
                value={field.value}
                onBlur={field.onBlur}
                onChange={(event) => {
                  const raw = event.target.value;
                  const caret = event.target.selectionStart ?? raw.length;
                  const masked = maskAccessCodeInput(raw);
                  field.onChange(masked);
                  const position = caretAfterMask(raw, caret, masked);
                  requestAnimationFrame(() => {
                    if (document.activeElement === inputRef.current)
                      inputRef.current?.setSelectionRange(position, position);
                  });
                }}
                placeholder={ACCESS_CODE_PLACEHOLDER}
                autoComplete="off"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                inputMode="text"
                maxLength={64}
                aria-invalid={fieldError ? true : undefined}
                aria-describedby={[ids.hint, fieldError ? ids.error : null, ids.count]
                  .filter(Boolean)
                  .join(' ')}
                className="h-full min-w-0 flex-1 bg-transparent pr-3.5 font-mono text-[15px] tracking-wider text-foreground uppercase outline-none placeholder:text-subtle-foreground placeholder:normal-case"
              />
              <span
                id={ids.count}
                className={cn(
                  'tabular mr-3 shrink-0 text-xs',
                  symbols === ACCESS_CODE_SYMBOLS ? 'text-success' : 'text-subtle-foreground',
                )}
              >
                <span className="sr-only">Characters entered: </span>
                {symbols}/{ACCESS_CODE_SYMBOLS}
              </span>
            </div>
          )}
        />
        <p id={ids.hint} className="text-[13px] text-muted-foreground">
          Paste it or type it — spaces, dashes and lower case are fine.
        </p>
        {fieldError ? (
          <p id={ids.error} role="alert" className="flex items-start gap-1.5 text-[13px] text-destructive">
            <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            {fieldError}
          </p>
        ) : null}
      </div>

      <Button type="submit" size="lg" loading={signIn.isPending} loadingText="Signing in…" disabled={locked}>
        Sign in
        <ArrowRight aria-hidden />
      </Button>
    </form>
  );
}
