# eProc — Remigrar Processo por Módulo

Userscript para automação em lote da remigração de processos por módulo no sistema eProc do TJSP. Processa os módulos **CAS**, **ZIP** e **Vídeos** de cada processo de forma sequencial, com suporte a checkpoint, múltiplas instâncias paralelas e exportação de resultados em CSV.

---

## Pré-requisitos

### 1. Instalar o Tampermonkey

Abra a loja de extensões do seu navegador (Chrome, Edge ou Firefox), procure por **Tampermonkey** e instale a extensão. Após instalar, confirme que o ícone do Tampermonkey apareceu próximo à barra de endereço.

### 2. Ativar o modo desenvolvedor no navegador

Isso é necessário para o Tampermonkey rodar o script sem bloqueio.

- Vá em **Configurações → Extensões**
- No canto superior direito, ative **Modo do desenvolvedor**

### 3. Configurações do Tampermonkey

- Clique no ícone do Tampermonkey → **Painel** → **Configurações**
- Confirme que estas opções estão ativas:
  - Permitir scripts de usuário
  - Permitir acesso a abas
  - Permitir requisições remotas
  - Modo estrito desativado *(se existir no seu navegador)*

---

## Instalação

👉 [Clique aqui para instalar o script](https://cdn.jsdelivr.net/gh/rsalvessap/eproc-scripts-gerais@master/eproc-remigrar/eproc-remigrar.user.js)

O Tampermonkey abrirá automaticamente a tela de confirmação — clique em **Instalar**.

Após instalar, acesse a página do remigrar no eProc e a HUD aparecerá automaticamente no canto inferior direito:
`https://eproc1g.tjsp.jus.br/eproc/controlador.php?acao=remigrar_processo`

---

## Como usar

### Preparar o arquivo de entrada

Crie um arquivo `.txt` ou `.csv` com os números de processo, um por linha. O script aceita os formatos com ou sem máscara:

```
1234567-89.2023.8.26.0001
12345678920238260001
```

### Executar em uma única aba

1. Faça o upload do arquivo na HUD
2. Deixe **Instância: 1** e **Total: 1**
3. Clique em **Iniciar**

### Executar em múltiplas abas (processamento paralelo)

Para listas grandes, é possível dividir o trabalho entre várias abas abertas ao mesmo tempo:

1. Abra a página do remigrar em **N abas**
2. Em cada aba, faça upload do **mesmo arquivo**
3. Configure cada aba com um número de instância diferente:
   - Aba 1 → Instância **1** de **N**
   - Aba 2 → Instância **2** de **N**
   - *(e assim por diante)*
4. Clique em **Iniciar** em cada aba

Cada aba processará automaticamente sua fatia da lista sem conflito com as demais.

### Controles disponíveis

| Botão | Ação |
|---|---|
| Iniciar | Inicia o processamento |
| Pausar | Pausa e salva o estado atual |
| Retomar | Continua de onde parou |
| Parar | Encerra e exporta os resultados obtidos até o momento |
| Exportar agora | Exporta o CSV parcial sem interromper o processamento |

---

## Resultados

A cada **100 processos** o script exporta automaticamente um arquivo CSV parcial:

```
remigrar_results_inst1_chunk001.csv
remigrar_results_inst1_chunk002.csv
...
```

Ao finalizar, exporta um CSV consolidado com todos os resultados. Cada linha contém:

| Campo | Descrição |
|---|---|
| `caso` | Número do processo |
| `timestamp` | Data e hora do processamento |
| `cas_status` | Resultado do módulo CAS |
| `zip_status` | Resultado do módulo ZIP |
| `vid_status` | Resultado do módulo Vídeos |
| `resumo` | Status geral: `success`, `info`, `error` ou `rate_limited` |

---

## Recuperação automática

O script salva um **checkpoint** antes de cada submissão. Se o navegador fechar ou a aba recarregar inesperadamente, ao retornar à página o processamento é retomado automaticamente do ponto onde parou, sem reprocessar casos já concluídos.

---

## Observações

- O script aguarda até **2 minutos** pela resposta do servidor por submissão
- Em caso de rate limit, aguarda **30 segundos** antes de tentar novamente
- Roles de acesso ao eProc devem permitir a ação de remigração
