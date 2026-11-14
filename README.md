# Ponte SSHFS

Painel local em Node.js para criar perfis e montar pastas remotas via SSHFS no Linux.

## Requisitos

- Linux com `sshfs`, `fusermount3` e `findmnt` instalados.
- Node.js 20 ou superior.
- Acesso SSH autorizado ao servidor remoto.

No Ubuntu/Debian, caso falte SSHFS: `sudo apt install sshfs`.

## Iniciar

```bash
npm start
```

Abra `http://127.0.0.1:4173` no mesmo computador. Para outra porta, use `PORT=4174 npm start`. Não exponha o painel à rede: ele escuta somente em `127.0.0.1`.

**Inicie sempre como usuário comum**, sem `sudo`: o servidor recusa a inicialização como `root` e as montagens pertencem ao usuário que executa o painel.

Crie um perfil informando host/IP, porta, usuário SSH e formas de autenticação. **Não há campos para caminho remoto ou ponto de montagem:** o painel envia `usuario@HOST:` ao SSHFS, sem rota após os dois-pontos. O servidor SFTP determina a pasta inicial (normalmente a home do usuário SSH, como `/data/data/com.termux/files/home` no Termux), respeitando as permissões desse usuário. O painel cria automaticamente uma pasta local em `~/Remotos/host-porta-usuario`. Essa pasta existe no Linux do painel, não no dispositivo remoto. O SSHFS exige um ponto de montagem local, mas você não precisa escolher nem digitar um. Perfis antigos conservam seu ponto de montagem local ao serem editados. Clique em **Abrir pasta** após montar para navegar a partir da pasta inicial do SFTP. Essa montagem não inclui automaticamente as pastas acima dela. Por segurança, nunca montamos sobre a home inteira do Linux. O painel tenta, em sequência, os métodos de autenticação selecionados: agente SSH, chave privada específica e senha. A senha nunca é gravada.

### Pré-acesso SSH

Em cada conexão, **Testar SSH e localizar** executa `ssh -p PORTA usuario@HOST 'pwd -P'` com um marcador interno para ignorar banners do shell (com flags de segurança e modo de rede quando configurados) e mostra no cartão o diretório inicial retornado pelo SSH. Com senha, o painel deixa o SSH/SSHFS usar o prompt original de autenticação do sistema, como `ksshaskpass`. A senha não passa pelo painel nem é salva no JSON. Ao montar com agente/chave, o painel consulta novamente e passa o caminho confirmado ao SSHFS; ao montar com senha, o SFTP escolhe sua pasta inicial. Isso confirma somente a consulta SSH, não a montagem SSHFS. A consulta não é automática. O caminho encontrado não é salvo no JSON: ele é temporário e desaparece ao recarregar a página. “Disponível no Linux em” indica o ponto de montagem local, que é diferente do caminho remoto.

### Conexões salvas

Cada perfil fica em um arquivo JSON separado na pasta `conexões/`, ao lado de `server.js`, com permissões restritas ao usuário (diretório `0700`, arquivos `0600`). O nome do arquivo é o identificador do perfil, para evitar sobrescritas quando nomes se repetem. Na primeira execução, os perfis do armazenamento anterior (`~/.config/sshfs-painel/profiles.json`) são importados; o arquivo antigo é renomeado com sufixo `.migrated-...` e preservado como backup. Não coloque senhas nesses JSONs; elas são solicitadas apenas ao montar.

### Modos e opções

- **Automático:** tenta conexão direta; se houver erro de transporte reconhecido, tenta IPv4 e depois IPv6. Não repete tentativas por erro de autenticação ou host key.
- **Direto:** usa IP ou domínio e deixa o SSH escolher a família de rede.
- **IPv4 / IPv6:** fixa a família de endereços com `AddressFamily=inet` ou `AddressFamily=inet6`.
- **Servidor intermediário:** usa `ProxyJump` com host, usuário e porta informados. O salto precisa aceitar uma credencial SSH disponível ao usuário; o painel não solicita uma segunda senha para o salto.
- **Opções:** compressão SSH, montagem somente leitura, acompanhamento de links simbólicos e mapeamento do usuário remoto (`idmap=user`). Marque apenas as que fizerem sentido para seu servidor; opções não substituem acesso SSH válido.

Não há campo para flags arbitrárias: o painel aceita somente as opções acima para evitar comandos inesperados.

Em **Conexões salvas**, o painel testa automaticamente a porta TCP de cada perfil ao carregar/atualizar a lista e após salvar ou montar, mostrando **Porta acessível** ou **Porta indisponível**, separadamente de **Pasta montada**. É uma tentativa curta por perfil (até 2,5 segundos), sem autenticação; porta acessível não prova que o login, SFTP ou SSHFS funcionarão, e porta indisponível não prova que o dispositivo está desligado (pode ser rede, firewall ou sshd parado). O botão **Testar porta** faz a mesma verificação com prazo de até 5 segundos; não comprova autenticação nem permissões na pasta remota. Se aparecer “Painel local indisponível”, execute `npm start` no diretório do projeto, mantenha esse terminal aberto e recarregue a página no endereço exibido. No Termux, confira `sshd` ativo, a porta configurada (frequentemente 8022), que ambos os dispositivos estão na mesma rede e que a pasta desejada é acessível ao usuário SSH. O primeiro contato com um host desconhecido usa `StrictHostKeyChecking=accept-new`: confirme a fingerprint do servidor por um canal confiável antes de montar. Um host cuja chave mudou não será aceito automaticamente.

A pasta montada aparece no gerenciador de arquivos do Linux. Para removê-la, clique em **Desmontar**. A exclusão de um perfil não apaga a pasta local.

## Testes

```bash
npm test
```

## Limitações

- Não configura servidores SSH, firewalls, VPNs nem cria credenciais.
- Não descobre senhas ou chaves; apenas tenta os métodos explicitamente selecionados.
- Não monta automaticamente ao iniciar o computador.
- Para diagnósticos detalhados do subsistema SFTP, use `sftp -P PORTA usuario@HOST` no terminal. SSH interativo funcionar não garante que o SFTP esteja disponível. O SSHFS monta a pasta inicial do SFTP usando `usuario@HOST:` (sem caminho após os dois-pontos). Uma montagem antiga de `usuario@HOST:/` pode até aparecer como montada, mas ter erro de permissão ao listar: desmonte-a e monte novamente para usar a nova origem.
