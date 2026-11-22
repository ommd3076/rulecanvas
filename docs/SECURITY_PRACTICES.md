# RuleCanvas Security Practices

## Content Security Policy (CSP)
- Scripts restricted to trusted local origin: 'self'.
- Styles loaded with inline hash validation.
- Traversal protection rejects .. or encoded %2e%2e sequences on all static endpoints.

## Input Sanitization
- All rule node expressions are parsed deterministically without eval() or Function().
